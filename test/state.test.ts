import { describe, expect, test } from "bun:test";
import { initialState, reducer, selectedJob, visibleJobs } from "../src/state";
import type { Job, LogFileTail } from "../src/types";

function job(label: string): Job {
  return {
    label,
    plistPath: `/tmp/${label}.plist`,
    domain: "user",
    arguments: [],
    keepAlive: false,
    runAtLoad: false,
    raw: {},
    runtime: { label, loaded: true, state: "unknown", enabled: true },
    category: "idle",
  };
}

const jobs = [job("com.example.alpha"), job("com.example.Beta"), job("org.other.gamma")];
const loaded = reducer(initialState, {
  type: "jobs-updated",
  jobs,
  warnings: [],
  at: new Date(),
});

describe("filter", () => {
  test("label の部分一致で大文字小文字を区別しない", () => {
    const s = reducer(loaded, { type: "filter-append", char: "b" });
    expect(visibleJobs(s).map((j) => j.label)).toEqual(["com.example.Beta"]);
  });

  test("append と backspace が積み上がる", () => {
    let s = loaded;
    for (const c of "gam") s = reducer(s, { type: "filter-append", char: c });
    expect(s.filter).toBe("gam");
    expect(visibleJobs(s)).toHaveLength(1);
    s = reducer(s, { type: "filter-backspace" });
    expect(s.filter).toBe("ga");
    s = reducer(s, { type: "filter-clear" });
    expect(s.filter).toBe("");
    expect(visibleJobs(s)).toHaveLength(3);
  });

  test("フィルタ解除後も選択中の label を追従する", () => {
    let s = reducer(loaded, { type: "filter-append", char: "g" });
    expect(selectedJob(s)?.label).toBe("org.other.gamma");
    s = reducer(s, { type: "filter-clear" });
    expect(selectedJob(s)?.label).toBe("org.other.gamma");
    expect(s.selectedIndex).toBe(2);
  });
});

describe("logs モードと設定", () => {
  const tail: LogFileTail = {
    kind: "extra",
    tag: "log1",
    path: "/tmp/x.log",
    lines: ["hello"],
    size: 6,
    ino: 1,
    mtimeMs: 1,
  };

  test("logs を開閉すると tail を捨てて戻り先へ戻る", () => {
    let s = reducer(loaded, { type: "set-mode", mode: "detail" });
    s = reducer(s, { type: "open-logs" });
    expect(s.mode).toBe("logs");
    expect(s.logsReturnMode).toBe("detail");
    s = reducer(s, { type: "log-tails", tails: [tail] });
    expect(s.logTails).toEqual([tail]);
    s = reducer(s, { type: "close-logs" });
    expect(s.mode).toBe("detail");
    expect(s.logTails).toEqual([]);
  });

  test("config-updated が設定と警告を差し替える", () => {
    const s = reducer(loaded, {
      type: "config-updated",
      config: { extraLogPaths: { "com.example.alpha": ["/tmp/x.log"] } },
      warnings: ["壊れています"],
    });
    expect(s.config.extraLogPaths["com.example.alpha"]).toEqual(["/tmp/x.log"]);
    expect(s.configWarnings).toEqual(["壊れています"]);
    // 設定の警告は jobs 側の warnings を上書きしない
    expect(s.warnings).toEqual([]);
  });
});

describe("jobs-updated の選択追従", () => {
  test("再取得で並びが変わっても label で追従する", () => {
    let s = reducer(loaded, { type: "move-selection", delta: 2 });
    expect(selectedJob(s)?.label).toBe("org.other.gamma");
    s = reducer(s, {
      type: "jobs-updated",
      jobs: [job("org.other.gamma"), job("com.example.alpha")],
      warnings: [],
      at: new Date(),
    });
    expect(selectedJob(s)?.label).toBe("org.other.gamma");
    expect(s.selectedIndex).toBe(0);
  });

  test("選択していた job が消えたら index を clamp する", () => {
    let s = reducer(loaded, { type: "move-selection", delta: 2 });
    s = reducer(s, {
      type: "jobs-updated",
      jobs: [job("com.example.alpha")],
      warnings: [],
      at: new Date(),
    });
    expect(s.selectedIndex).toBe(0);
  });
});
