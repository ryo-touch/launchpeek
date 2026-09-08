import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  layoutLogBlocks,
  logSourcesOf,
  refreshTail,
  tailFile,
  TAIL_LINES,
} from "../src/core/logs";
import type { Job, LogFileTail, LogSource } from "../src/types";

const dir = await mkdtemp(join(tmpdir(), "launchpeek-logs-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

function out(path: string): LogSource {
  return { kind: "out", tag: "out", path };
}

function tail(overrides: Partial<LogFileTail> = {}): LogFileTail {
  return {
    kind: "out",
    tag: "out",
    path: "/tmp/a.out",
    lines: [],
    size: 0,
    ino: 0,
    mtimeMs: 0,
    ...overrides,
  };
}

describe("tailFile", () => {
  test("末尾 N 行だけを読む", async () => {
    const path = join(dir, "long.log");
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    await writeFile(path, `${lines.join("\n")}\n`);
    const result = await tailFile(out(path));
    expect(result.lines).toHaveLength(TAIL_LINES);
    expect(result.lines[0]).toBe("line 300");
    expect(result.lines[TAIL_LINES - 1]).toBe("line 499");
    expect(result.error).toBeUndefined();
    // 置き換え判定の起点になるので必ず入っていること
    expect(result.ino).toBeGreaterThan(0);
    expect(result.mtimeMs).toBeGreaterThan(0);
  });

  test("存在しないファイルは error になる", async () => {
    const result = await tailFile({
      kind: "err",
      tag: "err",
      path: join(dir, "missing.log"),
    });
    expect(result.error).toBeDefined();
    expect(result.lines).toEqual([]);
  });

  test("読めないパス (ディレクトリ) でも落ちずに error になる", async () => {
    // 設定にディレクトリを書いてしまったケース。stat は通るが読み出しで失敗する
    const path = join(dir, "a-directory");
    await mkdir(path, { recursive: true });
    const result = await tailFile({ kind: "extra", tag: "log1", path });
    expect(result.error).toBeDefined();
    expect(result.lines).toEqual([]);
    expect(result.path).toBe(path);
  });
});

describe("refreshTail", () => {
  test("追記分だけを差分で読む", async () => {
    const path = join(dir, "grow.log");
    await writeFile(path, "first\n");
    const prev = await tailFile(out(path));
    expect(prev.lines).toEqual(["first"]);

    const unchanged = await refreshTail(prev);
    expect(unchanged.changed).toBe(false);

    await appendFile(path, "second\nthird\n");
    const grown = await refreshTail(prev);
    expect(grown.changed).toBe(true);
    expect(grown.tail.lines).toEqual(["first", "second", "third"]);
  });

  test("サイズが縮んだら (ローテーション) 読み直す", async () => {
    const path = join(dir, "rotate.log");
    await writeFile(path, "old content that is long\n");
    const prev = await tailFile(out(path));
    await writeFile(path, "new\n");
    const result = await refreshTail(prev);
    expect(result.changed).toBe(true);
    expect(result.tail.lines).toEqual(["new"]);
  });

  test("truncate 後に書き直しても古い内容を出し続けない", async () => {
    const path = join(dir, "truncate.log");
    await writeFile(path, "old line 1\nold line 2\n");
    const prev = await tailFile(out(path));
    await truncate(path, 0);
    await appendFile(path, "fresh\n");
    const result = await refreshTail(prev);
    expect(result.changed).toBe(true);
    expect(result.tail.lines).toEqual(["fresh"]);
  });

  test("同じサイズで中身が入れ替わったら読み直す", async () => {
    const path = join(dir, "same-size.log");
    await writeFile(path, "aaaa\n");
    const prev = await tailFile(out(path));
    // 同じ長さで書き直す。writeFile は inode を保つので mtime だけが手掛かりになる
    await writeFile(path, "bbbb\n");
    // FS のタイムスタンプ粒度に依存させないため明示的に進める
    await utimes(path, new Date(), new Date(prev.mtimeMs + 5000));

    const info = await stat(path);
    expect(info.size).toBe(prev.size);
    expect(info.ino).toBe(prev.ino);

    const result = await refreshTail(prev);
    expect(result.changed).toBe(true);
    expect(result.tail.lines).toEqual(["bbbb"]);
  });

  test("size と mtime が同じでも inode が違えば読み直す", async () => {
    const path = join(dir, "same-stat.log");
    await writeFile(path, "aaaa\n");
    const prev = await tailFile(out(path));
    await rename(path, join(dir, "same-stat.log.1"));
    await writeFile(path, "bbbb\n");
    const info = await stat(path);
    // size と mtime を新ファイルに揃え、inode の違いだけが検知の根拠になる状態にする
    const sameStat: LogFileTail = {
      ...prev,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
    expect(info.ino).not.toBe(prev.ino);

    const result = await refreshTail(sameStat);
    expect(result.changed).toBe(true);
    expect(result.tail.lines).toEqual(["bbbb"]);
  });

  test("symlink の張り替えに追従する", async () => {
    const a = join(dir, "target-a.log");
    const b = join(dir, "target-b.log");
    const link = join(dir, "current.log");
    await writeFile(a, "from a\n");
    await writeFile(b, "from b\n");
    await symlink(a, link);
    const prev = await tailFile(out(link));
    expect(prev.lines).toEqual(["from a"]);

    await unlink(link);
    await symlink(b, link);
    const result = await refreshTail(prev);
    expect(result.changed).toBe(true);
    expect(result.tail.lines).toEqual(["from b"]);
  });

  test("mtime だけ動いて中身が同じなら changed にしない", async () => {
    // /dev/null のように size 0 のまま mtime が動くファイルで毎秒再描画しないこと
    const path = join(dir, "touch-only.log");
    await writeFile(path, "same\n");
    const prev = await tailFile(out(path));
    await utimes(path, new Date(), new Date(prev.mtimeMs + 5000));
    const result = await refreshTail(prev);
    expect(result.changed).toBe(false);
    // ino / mtime を更新しておかないと次回も同じ判定を繰り返す
    expect(result.tail.mtimeMs).not.toBe(prev.mtimeMs);
    expect(result.tail.lines).toEqual(["same"]);

    // 更新後の tail をそのまま渡しても再度読み直しにならない
    expect((await refreshTail(result.tail)).changed).toBe(false);
  });

  test("/dev/null は毎回 changed にならない", async () => {
    const prev = await tailFile(out("/dev/null"));
    expect(prev.error).toBeUndefined();
    await Bun.write("/dev/null", "mtime を動かす\n");
    expect((await refreshTail(prev)).changed).toBe(false);
  });

  test("読めないままのパスは繰り返し changed にしない", async () => {
    const path = join(dir, "still-a-directory");
    await mkdir(path, { recursive: true });
    const prev = await tailFile({ kind: "extra", tag: "log1", path });
    expect(prev.error).toBeDefined();
    const result = await refreshTail(prev);
    expect(result.tail.error).toBeDefined();
    expect(result.changed).toBe(false);
  });

  test("消えたファイルは error に落ち、復活したら読み直す", async () => {
    const path = join(dir, "vanish.log");
    await writeFile(path, "hello\n");
    const prev = await tailFile(out(path));
    await rm(path);
    const gone = await refreshTail(prev);
    expect(gone.changed).toBe(true);
    expect(gone.tail.error).toBeDefined();

    await writeFile(path, "back\n");
    const revived = await refreshTail(gone.tail);
    expect(revived.tail.lines).toEqual(["back"]);
    expect(revived.tail.error).toBeUndefined();
    expect(revived.tail.ino).toBeGreaterThan(0);
    expect(revived.tail.mtimeMs).toBeGreaterThan(0);
  });
});

describe("logSourcesOf", () => {
  const job = {
    stdoutPath: "/tmp/a.out",
    stderrPath: "/tmp/a.err",
  } as Job;

  test("追加ログなしでは従来どおり stdout / stderr だけを返す", () => {
    expect(logSourcesOf(job)).toEqual([
      { kind: "out", tag: "out", path: "/tmp/a.out" },
      { kind: "err", tag: "err", path: "/tmp/a.err" },
    ]);
  });

  test("stdout と stderr が同じパスなら 1 つにまとめる", () => {
    const same = { ...job, stderrPath: "/tmp/a.out" } as Job;
    expect(logSourcesOf(same)).toHaveLength(1);
  });

  test("/dev/null も従来どおりソースとして扱う", () => {
    const devNull = { ...job, stdoutPath: "/dev/null" } as Job;
    expect(logSourcesOf(devNull).map((s) => s.path)).toEqual([
      "/dev/null",
      "/tmp/a.err",
    ]);
  });

  test("追加ログを log1 から採番して末尾に足す", () => {
    expect(logSourcesOf(job, ["/tmp/x.log", "/tmp/y.log"])).toEqual([
      { kind: "out", tag: "out", path: "/tmp/a.out" },
      { kind: "err", tag: "err", path: "/tmp/a.err" },
      { kind: "extra", tag: "log1", path: "/tmp/x.log" },
      { kind: "extra", tag: "log2", path: "/tmp/y.log" },
    ]);
  });

  test("stdout / stderr と重複する追加ログは 1 回だけ表示する", () => {
    const sources = logSourcesOf(job, ["/tmp/a.err", "/tmp/x.log"]);
    expect(sources.map((s) => s.path)).toEqual([
      "/tmp/a.out",
      "/tmp/a.err",
      "/tmp/x.log",
    ]);
    // 捨てた分を飛ばさず log1 から採番する
    expect(sources[2]?.tag).toBe("log1");
  });

  test("追加ログ同士の重複も 1 回だけ表示する", () => {
    const sources = logSourcesOf(job, ["/tmp/x.log", "/tmp/x.log"]);
    expect(sources.filter((s) => s.kind === "extra")).toHaveLength(1);
  });

  test("stdout / stderr が無ければ追加ログだけを返す", () => {
    expect(logSourcesOf({} as Job, ["/tmp/x.log"])).toEqual([
      { kind: "extra", tag: "log1", path: "/tmp/x.log" },
    ]);
  });
});

describe("layoutLogBlocks", () => {
  function lines(prefix: string, count: number): string[] {
    return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  }

  test("行数の少ないソースが大きいソースに押し出されない", () => {
    const layout = layoutLogBlocks(
      [
        tail({ kind: "err", tag: "err", path: "/e", lines: lines("e", 200) }),
        tail({ kind: "extra", tag: "log1", path: "/x", lines: lines("x", 3) }),
      ],
      10,
    );
    expect(layout.hiddenSources).toBe(0);
    // ヘッダー 2 行 + 本文 8 行。小さい方は全行、残りを大きい方が取る
    expect(layout.blocks[1]?.lines).toEqual(["[log1] x0", "[log1] x1", "[log1] x2"]);
    expect(layout.blocks[0]?.lines).toHaveLength(5);
    expect(layout.blocks[0]?.hiddenCount).toBe(195);
    const used =
      layout.blocks.length +
      layout.blocks.reduce((n, b) => n + b.lines.length, 0);
    expect(used).toBe(10);
  });

  test("末尾 (最新) を残す", () => {
    const layout = layoutLogBlocks(
      [tail({ lines: lines("a", 5) })],
      3,
    );
    expect(layout.blocks[0]?.lines).toEqual(["[out] a3", "[out] a4"]);
    expect(layout.blocks[0]?.hiddenCount).toBe(3);
  });

  test("ヘッダー分しか無いときは本文 0 行で全ソースを見せる", () => {
    const layout = layoutLogBlocks(
      [
        tail({ tag: "out", path: "/a", lines: lines("a", 5) }),
        tail({ tag: "err", path: "/b", lines: lines("b", 5) }),
        tail({ tag: "log1", path: "/c", lines: lines("c", 5) }),
      ],
      3,
    );
    expect(layout.hiddenSources).toBe(0);
    expect(layout.blocks).toHaveLength(3);
    for (const block of layout.blocks) expect(block.lines).toEqual([]);
  });

  test("行数がソース数に足りなければ hiddenSources で伝える", () => {
    const layout = layoutLogBlocks(
      [
        tail({ tag: "out", path: "/a", lines: lines("a", 5) }),
        tail({ tag: "err", path: "/b", lines: lines("b", 5) }),
      ],
      1,
    );
    // 1 行しか無いので注記だけを出す。負の割り当てを作らない
    expect(layout.blocks).toEqual([]);
    expect(layout.hiddenSources).toBe(2);
  });

  test("rows が 0 以下なら注記も出さない (割り当てを超えないため)", () => {
    expect(layoutLogBlocks([tail()], 0)).toEqual({
      blocks: [],
      hiddenSources: 0,
    });
    expect(layoutLogBlocks([tail()], -5)).toEqual({
      blocks: [],
      hiddenSources: 0,
    });
  });

  test("どの行数でも割り当てを超えず、余った行を残さない", () => {
    const sets = [
      [tail({ tag: "a", path: "/a", lines: lines("a", 200) }), tail({ tag: "b", path: "/b", lines: lines("b", 3) })],
      [tail({ tag: "a", path: "/a", lines: [] }), tail({ tag: "b", path: "/b", lines: [] })],
      [tail({ tag: "a", path: "/a", lines: lines("a", 5), error: "ENOENT" }), tail({ tag: "b", path: "/b", lines: lines("b", 100) })],
      [
        tail({ tag: "a", path: "/a", lines: lines("a", 1) }),
        tail({ tag: "b", path: "/b", lines: lines("b", 1) }),
        tail({ tag: "c", path: "/c", lines: lines("c", 1) }),
        tail({ tag: "d", path: "/d", lines: lines("d", 400) }),
      ],
    ];
    for (let rows = 0; rows <= 30; rows++) {
      for (const tails of sets) {
        const layout = layoutLogBlocks(tails, rows);
        const used =
          layout.blocks.length +
          layout.blocks.reduce((n, b) => n + b.lines.length, 0) +
          (layout.hiddenSources > 0 ? 1 : 0);
        expect(used).toBeLessThanOrEqual(Math.max(0, rows));
        for (const block of layout.blocks) {
          expect(block.hiddenCount).toBeGreaterThanOrEqual(0);
        }
        // 予算が余っているのに隠している行があれば配分漏れ
        if (used < rows) {
          for (const block of layout.blocks) expect(block.hiddenCount).toBe(0);
        }
      }
    }
  });

  test("ソースが無ければ空を返す", () => {
    expect(layoutLogBlocks([], 10)).toEqual({ blocks: [], hiddenSources: 0 });
  });

  test("読めないソースは本文の予算を食わない", () => {
    const layout = layoutLogBlocks(
      [
        tail({ tag: "log1", path: "/x", lines: [], error: "ENOENT" }),
        tail({ tag: "err", path: "/e", lines: lines("e", 20) }),
      ],
      6,
    );
    expect(layout.blocks[0]?.lines).toEqual([]);
    expect(layout.blocks[0]?.error).toBe("ENOENT");
    // ヘッダー 2 行を除いた 4 行を健全なソースが全部使う
    expect(layout.blocks[1]?.lines).toHaveLength(4);
  });

  test("必要行数が同じなら元の順序で配分する", () => {
    const layout = layoutLogBlocks(
      [
        tail({ tag: "out", path: "/a", lines: lines("a", 10) }),
        tail({ tag: "err", path: "/b", lines: lines("b", 10) }),
      ],
      7,
    );
    expect(layout.blocks.map((b) => b.lines.length)).toEqual([2, 3]);
  });
});
