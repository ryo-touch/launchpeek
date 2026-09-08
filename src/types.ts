export type Domain = "user" | "system";

export type JobState =
  | "running"
  | "waiting"
  | "disabled"
  | "not-loaded"
  | "unknown";

export interface CalendarInterval {
  minute?: number;
  hour?: number;
  day?: number;
  weekday?: number;
  month?: number;
}

export interface JobDefinition {
  label: string;
  plistPath: string;
  domain: Domain;
  program?: string;
  arguments: string[];
  startInterval?: number;
  startCalendarInterval?: CalendarInterval[];
  keepAlive: boolean;
  runAtLoad: boolean;
  stdoutPath?: string;
  stderrPath?: string;
  workingDirectory?: string;
  raw: Record<string, unknown>;
}

export interface JobRuntime {
  label: string;
  loaded: boolean;
  pid?: number;
  state: JobState;
  lastExitCode?: number;
  runCount?: number;
  enabled: boolean;
}

export type JobCategory = "busy" | "scheduled" | "failed" | "idle" | "disabled";

export interface Job extends JobDefinition {
  runtime: JobRuntime;
  nextRun?: Date;
  category: JobCategory;
}

export type ActionKind =
  | "kickstart"
  | "enable"
  | "disable"
  | "bootstrap"
  | "bootout"
  | "kill";

export interface ActionResult {
  ok: boolean;
  message: string;
}

// out / err は plist の StandardOutPath / StandardErrorPath、
// extra は設定ファイルで label に紐付けた追加ログ
export type LogKind = "out" | "err" | "extra";

// logs 画面のヘッダーと本文を同じ情報から描くため、参照元は必ずこの形で持ち回る
export interface LogSource {
  kind: LogKind;
  // 行頭 prefix とヘッダーに出す短い識別子。"out" / "err" / "log1".."logN"
  tag: string;
  path: string;
}

export interface LogFileTail extends LogSource {
  lines: string[];
  // 前回読んだ時点のファイルサイズ。差分読みの起点
  size: number;
  // 同じサイズのまま中身が入れ替わったケースを検知するための識別情報
  ino: number;
  mtimeMs: number;
  error?: string;
}

// 端末の行数に収まるよう割り当て済みの 1 ソース分
export interface LogBlock extends LogSource {
  error?: string;
  // prefix 付きの表示行。割り当て行数に収めた末尾のみ
  lines: string[];
  // 割り当てに収まらず隠れた行数
  hiddenCount: number;
}

export interface LogLayout {
  blocks: LogBlock[];
  // 行数が足りずヘッダーすら出せなかったソース数
  hiddenSources: number;
}
