import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfigPath,
  extraLogPathsFor,
  loadConfig,
  parseConfig,
  resolveLogPath,
} from "../src/core/config";

const dir = await mkdtemp(join(tmpdir(), "launchpeek-config-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

async function writeConfig(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body);
  return path;
}

describe("resolveLogPath", () => {
  test("~ と ~/ を展開する", () => {
    expect(resolveLogPath("~")).toBe(homedir());
    expect(resolveLogPath("~/Library/Logs/x.log")).toBe(
      join(homedir(), "Library/Logs/x.log"),
    );
  });

  test("絶対パスはそのまま使う", () => {
    expect(resolveLogPath("/var/log/x.log")).toBe("/var/log/x.log");
  });

  test("相対パス・$VAR・~foo は受け付けない", () => {
    // シェル評価をしないので、展開できない書き方は無視する
    expect(resolveLogPath("logs/x.log")).toBeUndefined();
    expect(resolveLogPath("./x.log")).toBeUndefined();
    expect(resolveLogPath("$HOME/x.log")).toBeUndefined();
    expect(resolveLogPath("~foo/x.log")).toBeUndefined();
  });
});

describe("parseConfig", () => {
  test("label ごとの追加ログを読む", () => {
    const { config, warnings } = parseConfig({
      extraLogPaths: { "jp.example.a": ["/tmp/a.log", "~/b.log"] },
    });
    expect(warnings).toEqual([]);
    expect(config.extraLogPaths["jp.example.a"]).toEqual([
      "/tmp/a.log",
      join(homedir(), "b.log"),
    ]);
  });

  test("空の設定は警告なしで空になる", () => {
    expect(parseConfig({})).toEqual({
      config: { extraLogPaths: {} },
      warnings: [],
    });
  });

  test("トップレベルが object でなければ設定を捨てて警告する", () => {
    const { config, warnings } = parseConfig([1, 2]);
    expect(config.extraLogPaths).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("トップレベル");
  });

  test("未知のトップレベルキーを警告する", () => {
    const { warnings } = parseConfig({ extraLogPath: {} });
    expect(warnings.join()).toContain("extraLogPath");
  });

  test("extraLogPaths が object でなければ警告する", () => {
    const { config, warnings } = parseConfig({ extraLogPaths: ["/tmp/a.log"] });
    expect(config.extraLogPaths).toEqual({});
    expect(warnings.join()).toContain("extraLogPaths");
  });

  test("壊れた label だけを落として他の label は残す", () => {
    const { config, warnings } = parseConfig({
      extraLogPaths: {
        "jp.example.good": ["/tmp/good.log"],
        "jp.example.notarray": "/tmp/bad.log",
        "jp.example.relative": ["logs/bad.log"],
        "jp.example.empty": [""],
        "jp.example.nonstring": [42],
      },
    });
    expect(Object.keys(config.extraLogPaths)).toEqual(["jp.example.good"]);
    // 原因を特定できるよう label とパスが警告文に出ること
    expect(warnings.join("\n")).toContain("jp.example.notarray");
    expect(warnings.join("\n")).toContain("logs/bad.log");
    expect(warnings.join("\n")).toContain("jp.example.empty");
    expect(warnings.join("\n")).toContain("jp.example.nonstring");
    expect(warnings.join("\n")).not.toContain("jp.example.good");
  });

  test("同じ label 内の重複パスをまとめる", () => {
    const { config } = parseConfig({
      extraLogPaths: { "jp.example.a": ["/tmp/a.log", "/tmp/a.log"] },
    });
    expect(config.extraLogPaths["jp.example.a"]).toEqual(["/tmp/a.log"]);
  });
});

describe("loadConfig", () => {
  test("ファイルが無いのは正常 (警告なし)", async () => {
    const result = await loadConfig(join(dir, "does-not-exist.json"));
    expect(result).toEqual({ config: { extraLogPaths: {} }, warnings: [] });
  });

  test("正常な JSON を読む", async () => {
    const path = await writeConfig(
      "ok.json",
      JSON.stringify({ extraLogPaths: { "jp.example.a": ["/tmp/a.log"] } }),
    );
    const { config, warnings } = await loadConfig(path);
    expect(warnings).toEqual([]);
    expect(extraLogPathsFor(config, "jp.example.a")).toEqual(["/tmp/a.log"]);
  });

  test("JSON が壊れていても落ちず、原因とパスを警告に出す", async () => {
    // 末尾カンマ。JSON.parse の失敗経路を「object でない」経路と区別する
    const path = await writeConfig(
      "broken.json",
      '{ "extraLogPaths": { "jp.example.a": ["/tmp/a.log",] } }',
    );
    const { config, warnings } = await loadConfig(path);
    expect(config.extraLogPaths).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("JSON");
    expect(warnings[0]).toContain(path);
  });

  test("設定パスがディレクトリでも落ちない", async () => {
    // Bun.file().exists() はディレクトリに false を返すため、設定なし扱いになる
    const { config, warnings } = await loadConfig(dir);
    expect(config.extraLogPaths).toEqual({});
    expect(warnings).toEqual([]);
  });
});

describe("extraLogPathsFor", () => {
  test("設定の無い label は空配列", () => {
    const { config } = parseConfig({
      extraLogPaths: { "jp.example.a": ["/tmp/a.log"] },
    });
    expect(extraLogPathsFor(config, "jp.example.b")).toEqual([]);
  });

  test("Object.prototype のキー名を label にしても配列を返す", () => {
    // plist の Label は外部入力。prototype 由来の関数を返すと呼び出し側で落ちる
    const { config } = parseConfig({
      extraLogPaths: { "jp.example.a": ["/tmp/a.log"] },
    });
    for (const label of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(extraLogPathsFor(config, label)).toEqual([]);
    }
  });

  test("__proto__ を label にした設定も own property として保持する", () => {
    const { config } = parseConfig({
      extraLogPaths: { ["__proto__"]: ["/tmp/x.log"] },
    });
    expect(extraLogPathsFor(config, "__proto__")).toEqual(["/tmp/x.log"]);
  });

  test("label は完全一致でしか引かない", () => {
    const { config } = parseConfig({
      extraLogPaths: { "jp.example.a": ["/tmp/a.log"] },
    });
    expect(extraLogPathsFor(config, "jp.example")).toEqual([]);
    expect(extraLogPathsFor(config, "jp.example.a.b")).toEqual([]);
  });
});

describe("defaultConfigPath", () => {
  test("~/.config/launchpeek/config.json を指す", () => {
    expect(defaultConfigPath()).toBe(
      join(homedir(), ".config/launchpeek/config.json"),
    );
  });
});
