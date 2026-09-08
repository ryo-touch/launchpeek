import { stat } from "node:fs/promises";
import type {
  Job,
  LogBlock,
  LogFileTail,
  LogLayout,
  LogSource,
} from "../types";

// ログ全体を state に読み込まないための上限 (SPEC: 末尾 200 行のみ保持)
export const TAIL_LINES = 200;
// 200 行分を拾うために末尾から読む最大バイト数
const TAIL_READ_BYTES = 256 * 1024;

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  // 末尾改行で終わるファイルの空要素を落とす
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export async function tailFile(
  source: LogSource,
  maxLines = TAIL_LINES,
): Promise<LogFileTail> {
  try {
    // ino / mtimeMs は refreshTail の置き換え判定の起点になる。
    // 二重 stat で取ると読んだ内容と識別情報がずれるので、必ずこの 1 回から取る
    const info = await stat(source.path);
    const start = Math.max(0, info.size - TAIL_READ_BYTES);
    const text = await Bun.file(source.path).slice(start, info.size).text();
    const lines = splitLines(text);
    // 途中から読んだ場合、先頭は行の断片なので捨てる
    if (start > 0 && lines.length > 0) lines.shift();
    return {
      ...source,
      lines: lines.slice(-maxLines),
      size: info.size,
      ino: info.ino,
      mtimeMs: info.mtimeMs,
    };
  } catch (err) {
    return {
      ...source,
      lines: [],
      size: 0,
      ino: 0,
      mtimeMs: 0,
      error: String(err),
    };
  }
}

export interface RefreshResult {
  tail: LogFileTail;
  changed: boolean;
}

// 読み直した結果が前回と同じなら再描画する意味が無い。
// /dev/null は size 0 のまま mtime だけが動くため、これが無いと毎秒再描画になる
function sameContent(a: LogFileTail, b: LogFileTail): boolean {
  if (a.error !== b.error) return false;
  if (a.lines.length !== b.lines.length) return false;
  return a.lines.every((line, i) => line === b.lines[i]);
}

// 1 秒ごとのポーリングから呼ばれる。判定は下の順序に意味があるので入れ替えないこと:
// error 復帰を ino 判定より先に見ることで、消えた後に inode を再利用して
// 再作成されたファイルを「変化なし」と誤判定せずに済む。
// また同サイズ書き換えを mtime で拾う代償として、毎回同じサイズで書き換わる
// ファイルは毎ポーリングで読み直しになる (stat 1 回で直す以上避けられない)
export async function refreshTail(prev: LogFileTail): Promise<RefreshResult> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(prev.path);
  } catch (err) {
    const errored = {
      ...prev,
      lines: [],
      size: 0,
      ino: 0,
      mtimeMs: 0,
      error: String(err),
    };
    return { tail: errored, changed: prev.error === undefined };
  }
  const source: LogSource = { kind: prev.kind, tag: prev.tag, path: prev.path };
  // 読み直した tail は内容が同じでも必ず採用する。ino / mtime を更新しないと
  // 次のポーリングでも同じ判定に落ちて読み直しを繰り返すため
  const retail = async (): Promise<RefreshResult> => {
    const next = await tailFile(source);
    return { tail: next, changed: !sameContent(prev, next) };
  };
  if (prev.error !== undefined) {
    // 消えていたファイルの復活は末尾から読み直す
    return retail();
  }
  if (info.ino !== prev.ino) {
    // rename + 再作成や symlink の張り替え。stat は symlink を辿るのでここで拾える
    return retail();
  }
  if (info.size < prev.size) {
    // truncate やローテーション
    return retail();
  }
  if (info.size === prev.size) {
    // 同じサイズでも mtime が動いていれば中身が入れ替わっている可能性がある
    if (info.mtimeMs === prev.mtimeMs) return { tail: prev, changed: false };
    return retail();
  }
  try {
    const text = await Bun.file(prev.path).slice(prev.size, info.size).text();
    const lines = [...prev.lines, ...splitLines(text)].slice(-TAIL_LINES);
    return {
      tail: {
        ...prev,
        lines,
        size: info.size,
        ino: info.ino,
        mtimeMs: info.mtimeMs,
      },
      changed: true,
    };
  } catch (err) {
    return {
      tail: {
        ...prev,
        lines: [],
        size: 0,
        ino: 0,
        mtimeMs: 0,
        error: String(err),
      },
      changed: true,
    };
  }
}

// plist の stdout / stderr に、設定ファイルの追加ログを足したものが表示対象。
// 重複排除はパス文字列の完全一致で行う (symlink 経由で同一ファイルを指す
// 別パスは別ソースとして出る。realpath 解決は行わない)
export function logSourcesOf(
  job: Job,
  extraPaths: readonly string[] = [],
): LogSource[] {
  const sources: LogSource[] = [];
  const seen = new Set<string>();
  const push = (source: LogSource) => {
    if (seen.has(source.path)) return;
    seen.add(source.path);
    sources.push(source);
  };
  if (job.stdoutPath !== undefined) {
    push({ kind: "out", tag: "out", path: job.stdoutPath });
  }
  if (job.stderrPath !== undefined) {
    push({ kind: "err", tag: "err", path: job.stderrPath });
  }
  let extraCount = 0;
  for (const path of extraPaths) {
    if (seen.has(path)) continue;
    // tag は実際に採用した追加ログの順に採番し、ヘッダーのパスと 1:1 で対応させる
    extraCount += 1;
    push({ kind: "extra", tag: `log${extraCount}`, path });
  }
  return sources;
}

function blockOf(tail: LogFileTail, rows: number): LogBlock {
  const shown = rows > 0 ? tail.lines.slice(-rows) : [];
  return {
    kind: tail.kind,
    tag: tail.tag,
    path: tail.path,
    error: tail.error,
    lines: shown.map((line) => `[${tail.tag}] ${line}`),
    hiddenCount: tail.lines.length - shown.length,
  };
}

// 表示用: 時系列に混ぜず (SPEC)、ソースごとに行数を配分する。
// 1 ソース = ヘッダー 1 行 + 本文。行数の少ないソースから配ることで、
// 古い行が大量に残った stderr が小さい追加ログを画面外へ押し出さないようにする。
// 戻り値が必要とする行数は必ず rows 以下になる
// (ヘッダー + 本文 + hiddenSources > 0 のときの注記 1 行を含めて数える)
export function layoutLogBlocks(
  tails: readonly LogFileTail[],
  rows: number,
): LogLayout {
  // 注記を出す 1 行すら無いので、隠したことも伝えられない
  if (rows <= 0) return { blocks: [], hiddenSources: 0 };

  let shown = tails;
  let hiddenSources = 0;
  if (tails.length > rows) {
    // ヘッダーすら並べられないので、隠した件数の注記に 1 行を使う
    const keep = Math.max(0, rows - 1);
    shown = tails.slice(0, keep);
    hiddenSources = tails.length - keep;
  }
  const noteRows = hiddenSources > 0 ? 1 : 0;
  let remaining = Math.max(0, rows - noteRows - shown.length);

  // 必要行数の昇順。同数なら元の順序を保って割り当てを決定的にする
  const order = shown
    .map((tail, index) => ({ index, need: tail.error !== undefined ? 0 : tail.lines.length }))
    .sort((a, b) => a.need - b.need || a.index - b.index);

  const allocated = new Array<number>(shown.length).fill(0);
  let left = order.length;
  for (const { index, need } of order) {
    const share = Math.floor(remaining / left);
    const give = Math.max(0, Math.min(need, share));
    allocated[index] = give;
    // 残予算は share ではなく実際に配った分だけ減らす。
    // 最後のソースは left === 1 で残り全部を受け取るため端数が余らない
    remaining -= give;
    left -= 1;
  }

  return {
    blocks: shown.map((tail, index) => blockOf(tail, allocated[index] ?? 0)),
    hiddenSources,
  };
}
