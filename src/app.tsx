import { Box, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { runAction } from "./core/actions";
import { copyLabel } from "./core/clipboard";
import {
  fetchDisabledLabels,
  fetchList,
  fetchPrint,
  type ListEntry,
  type PrintInfo,
} from "./core/launchctl";
import { extraLogPathsFor, loadConfig } from "./core/config";
import {
  layoutLogBlocks,
  logSourcesOf,
  refreshTail,
  tailFile,
} from "./core/logs";
import { emptySources, mergeJobs } from "./core/merge";
import { loadDefinitions } from "./core/plist";
import { watchAgentDirs } from "./core/watcher";
import { initialState, reducer, selectedJob, visibleJobs } from "./state";
import type { ActionKind, Job, LogFileTail } from "./types";
import { FilterInput } from "./ui/FilterInput";
import { Header } from "./ui/Header";
import { JobDetail } from "./ui/JobDetail";
import { JobList } from "./ui/JobList";
import { LogTail } from "./ui/LogTail";
import { StatusBar } from "./ui/StatusBar";

const uid = process.getuid?.() ?? 0;

// 設定の警告は原因が分かれば十分なので、logs 画面を潰さない範囲で出す
const MAX_CONFIG_WARNING_ROWS = 3;

// bootout / kill は取り消しが利かないので実行前に y の確認を挟む (SPEC)
const CONFIRM_ACTIONS: ReadonlySet<ActionKind> = new Set(["bootout", "kill"]);

const ACTION_KEYS: Record<string, ActionKind> = {
  r: "kickstart",
  e: "enable",
  d: "disable",
  u: "bootout",
  U: "bootstrap",
  x: "kill",
};

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reducer, initialState);

  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      // 初回描画は plist 定義と launchctl list だけで行い (SPEC 非機能要件)、
      // 遅い launchctl print の詳細は後から埋めて再描画する
      const warnings: string[] = [];
      const sources = emptySources();
      // 設定は一覧と同じ間隔で読み直すので、編集はホットリロードされる。
      // 初回描画を遅らせないよう plist / launchctl の読み取りと並行させる (SPEC 非機能要件)
      const configPromise = loadConfig();
      let definitions: Awaited<
        ReturnType<typeof loadDefinitions>
      >["definitions"] = [];
      try {
        const [loadResult, listEntries] = await Promise.all([
          loadDefinitions(),
          fetchList().catch((err): ListEntry[] => {
            warnings.push(String(err));
            return [];
          }),
        ]);
        definitions = loadResult.definitions;
        warnings.push(...loadResult.warnings);
        sources.list = new Map(listEntries.map((e) => [e.label, e]));
      } catch (err) {
        warnings.push(String(err));
      }
      // loadConfig は内部で catch 済みなので、上の失敗有無に関わらず必ず反映できる
      const configResult = await configPromise;
      dispatch({
        type: "config-updated",
        config: configResult.config,
        warnings: configResult.warnings,
      });
      dispatch({
        type: "jobs-updated",
        jobs: mergeJobs(definitions, sources, new Date()),
        warnings,
        at: new Date(),
      });

      try {
        const [disabledLabels, prints] = await Promise.all([
          fetchDisabledLabels(uid),
          Promise.all(
            definitions.map(
              async (def): Promise<[string, PrintInfo]> => [
                def.label,
                await fetchPrint(uid, def.label),
              ],
            ),
          ),
        ]);
        sources.disabledLabels = disabledLabels;
        sources.prints = new Map(prints);
      } catch (err) {
        warnings.push(String(err));
      }
      dispatch({
        type: "jobs-updated",
        jobs: mergeJobs(definitions, sources, new Date()),
        warnings,
        at: new Date(),
      });
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 一覧は 3 秒間隔でポーリングし、plist の変更検知時は即時再取得する (SPEC)。
    // 再取得中も前回の jobs を表示したまま操作できる
    const timer = setInterval(() => void refresh(), 3000);
    const stopWatching = watchAgentDirs(() => void refresh());
    return () => {
      clearInterval(timer);
      stopWatching();
    };
  }, [refresh]);

  // アクション結果のメッセージは 3 秒で消す (SPEC)
  const messageTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const showMessage = useCallback((message: string) => {
    dispatch({ type: "set-message", message });
    if (messageTimer.current !== undefined) clearTimeout(messageTimer.current);
    messageTimer.current = setTimeout(
      () => dispatch({ type: "clear-message" }),
      3000,
    );
  }, []);

  const executeAction = useCallback(
    async (kind: ActionKind, job: Job) => {
      const result = await runAction(kind, job);
      showMessage(result.message);
      // 実行後は必ず状態を再取得する (SPEC)
      void refresh();
    },
    [refresh, showMessage],
  );

  // logs ポーリングの effect が最新の jobs を stale closure なしで引けるようにする
  const jobsRef = useRef(state.jobs);
  jobsRef.current = state.jobs;
  const selectedLabel = selectedJob(state)?.label;
  const selectedExtraPaths =
    selectedLabel === undefined
      ? []
      : extraLogPathsFor(state.config, selectedLabel);
  const extraPathsRef = useRef(selectedExtraPaths);
  extraPathsRef.current = selectedExtraPaths;
  // 表示中に設定を直したときも拾えるよう effect の依存に含める。
  // 区切りには POSIX パスに現れない NUL を使う
  const extraPathsKey = selectedExtraPaths.join("\u0000");

  useEffect(() => {
    if (state.mode !== "logs") return;
    const job = jobsRef.current.find((j) => j.label === selectedLabel);
    if (!job) return;

    let stopped = false;
    let busy = false;
    let tails: LogFileTail[] = [];

    const publish = () => {
      if (!stopped) dispatch({ type: "log-tails", tails });
    };

    (async () => {
      tails = await Promise.all(
        logSourcesOf(job, extraPathsRef.current).map((s) => tailFile(s)),
      );
      publish();
    })();

    // logs モードの間は 1 秒ごとにサイズを確認し、増えていれば差分を読む (SPEC)
    const timer = setInterval(async () => {
      if (busy || tails.length === 0) return;
      busy = true;
      try {
        const results = await Promise.all(tails.map(refreshTail));
        tails = results.map((r) => r.tail);
        if (results.some((r) => r.changed)) publish();
      } finally {
        busy = false;
      }
    }, 1000);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [state.mode, selectedLabel, extraPathsKey]);

  // 高速連打やペーストでは複数キーが 1 チャンクで届くため、1 文字ずつ処理する
  useInput((chunk, key) => {
    const inputs = chunk.length > 1 ? chunk.split("") : [chunk];
    for (const input of inputs) handleKey(input, key);
  });

  function handleKey(
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1],
  ) {
    // 確認待ち中は y で実行、n / Esc / q で取り消し。他のキーは無視する
    if (state.pendingConfirm !== undefined) {
      const { kind, job } = state.pendingConfirm;
      if (input === "y") {
        dispatch({ type: "confirm-clear" });
        void executeAction(kind, job);
      } else if (input === "n" || input === "q" || key.escape) {
        dispatch({ type: "confirm-clear" });
      }
      return;
    }

    // フィルタ編集中は文字入力として扱う
    if (state.filterEditing) {
      if (key.escape) {
        dispatch({ type: "filter-clear" });
        dispatch({ type: "filter-editing", editing: false });
      } else if (key.return) {
        dispatch({ type: "filter-editing", editing: false });
      } else if (key.backspace || key.delete) {
        dispatch({ type: "filter-backspace" });
      } else if (input.length === 1 && !key.ctrl && !key.meta) {
        dispatch({ type: "filter-append", char: input });
      }
      return;
    }

    if (input === "q" || key.escape) {
      if (state.mode === "logs") {
        dispatch({ type: "close-logs" });
      } else if (state.mode === "detail") {
        dispatch({ type: "set-mode", mode: "list" });
      } else if (key.escape && state.filter !== "") {
        // list で Esc: フィルタが掛かっていれば解除する (SPEC)
        dispatch({ type: "filter-clear" });
      } else {
        exit();
      }
      return;
    }
    // logs は全画面表示なので閲覧キー以外は受け付けない
    if (state.mode === "logs") return;

    if (input === "/") {
      dispatch({ type: "filter-editing", editing: true });
      return;
    }
    if (input === "R") {
      void refresh();
      return;
    }
    if (input === "c" || input === "y") {
      const job = selectedJob(state);
      if (job) {
        void copyLabel(job.label).then((result) => showMessage(result.message));
      }
      return;
    }
    const actionKind = ACTION_KEYS[input];
    if (actionKind !== undefined) {
      const job = selectedJob(state);
      if (!job) return;
      if (CONFIRM_ACTIONS.has(actionKind)) {
        dispatch({ type: "confirm-request", kind: actionKind, job });
      } else {
        void executeAction(actionKind, job);
      }
      return;
    }
    if (input === "l") {
      dispatch({ type: "open-logs" });
      return;
    }
    if (input === "j" || key.downArrow || (key.ctrl && input === "n")) {
      dispatch({ type: "move-selection", delta: 1 });
    } else if (input === "k" || key.upArrow || (key.ctrl && input === "p")) {
      dispatch({ type: "move-selection", delta: -1 });
    } else if (input === "g") {
      dispatch({ type: "select-first" });
    } else if (input === "G") {
      dispatch({ type: "select-last" });
    } else if (key.return && state.mode === "list") {
      dispatch({ type: "set-mode", mode: "detail" });
    }
  }

  // pty によっては columns/rows が 0 になるため ?? ではなく || で補正する
  const width = stdout.columns || 80;
  const height = stdout.rows || 24;
  const listHeight = Math.max(3, height - 2);
  // detail モードでは左 4 割を縮小 JobList に使う
  const listWidth = Math.max(24, Math.floor(width * 0.4));
  const visible = visibleJobs(state);

  const confirmPrompt =
    state.pendingConfirm !== undefined
      ? `${state.pendingConfirm.kind} ${state.pendingConfirm.job.label}? (y/n)`
      : undefined;

  const statusLine = state.filterEditing ? (
    <FilterInput value={state.filter} />
  ) : (
    <StatusBar
      mode={state.mode}
      message={state.message}
      confirmPrompt={confirmPrompt}
      warnings={[...state.warnings, ...state.configWarnings]}
    />
  );

  if (state.mode === "logs") {
    // 全画面で LogTail。上部 1 行に label、ソースごとにヘッダー 1 行 + 本文 (SPEC)。
    // 行数配分は端末の高さが要るので描画時に決める。警告行のクランプもここ 1 箇所で行い、
    // LogTail 側では再クランプしないことで行数計算がずれないようにする
    // 端末が低いときは警告行がログを潰さないよう、本文に 1 行は残す
    const configWarnings = state.configWarnings.slice(
      0,
      Math.max(0, Math.min(MAX_CONFIG_WARNING_ROWS, height - 3)),
    );
    const layout = layoutLogBlocks(
      state.logTails,
      height - 1 - 1 - configWarnings.length,
    );
    const logsJob = selectedJob(state);
    return (
      <Box flexDirection="column" width={width}>
        <LogTail
          label={selectedLabel}
          layout={layout}
          configWarnings={configWarnings}
          sourceCount={
            logsJob ? logSourcesOf(logsJob, selectedExtraPaths).length : 0
          }
          height={height - 1}
        />
        {statusLine}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      <Header
        jobCount={state.jobs.length}
        visibleCount={visible.length}
        filter={state.filter}
        lastUpdated={state.lastUpdated}
        loading={state.loading}
      />
      {state.mode === "detail" ? (
        <Box height={listHeight}>
          <Box width={listWidth} flexShrink={0}>
            <JobList
              jobs={visible}
              selectedIndex={state.selectedIndex}
              height={listHeight}
              width={listWidth}
              compact
            />
          </Box>
          <JobDetail
            job={selectedJob(state)}
            extraLogPaths={selectedExtraPaths}
            height={listHeight}
          />
        </Box>
      ) : (
        <JobList
          jobs={visible}
          selectedIndex={state.selectedIndex}
          height={listHeight}
          width={width}
        />
      )}
      {statusLine}
    </Box>
  );
}
