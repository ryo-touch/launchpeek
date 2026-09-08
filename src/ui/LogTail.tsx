import { Box, Text } from "ink";
import type { LogBlock, LogLayout } from "../types";

interface Props {
  label?: string;
  layout: LogLayout;
  // 行数のクランプは app 側で済ませてある。ここは受け取った分をそのまま描く
  configWarnings: string[];
  // 表示対象のファイル数。初回読み込み中と「ログ指定なし」を区別するために使う
  sourceCount: number;
  height: number;
}

function BlockHeader({ block }: { block: LogBlock }) {
  const failed = block.error !== undefined;
  // パスは長くなりがちで truncate されるため、問題の印はパスより前に置く
  const marker = failed ? "(cannot read) " : "";
  const note = failed
    ? `  ${block.error}`
    : block.hiddenCount > 0
      ? `  (+${block.hiddenCount} lines above)`
      : "";
  return (
    // 折り返すと 1 ソース = ヘッダー 1 行の前提が崩れるため truncate する
    <Text wrap="truncate-end" dimColor={!failed}>
      <Text bold color={failed ? "red" : "yellow"}>
        {block.tag}
      </Text>
      {"  "}
      <Text color={failed ? "red" : undefined}>{marker}</Text>
      {`${block.path}${note}`}
    </Text>
  );
}

export function LogTail({
  label,
  layout,
  configWarnings,
  sourceCount,
  height,
}: Props) {
  const empty = layout.blocks.length === 0 && layout.hiddenSources === 0;
  return (
    <Box flexDirection="column" height={height}>
      <Text bold color="cyan" wrap="truncate-end">
        {label ?? "-"}
      </Text>
      {configWarnings.map((warning, i) => (
        <Text key={i} color="red" wrap="truncate-end">
          {`config: ${warning}`}
        </Text>
      ))}
      {empty ? (
        // 初回の読み込み中も blocks は空なので、設定が無いのと混同させない
        <Text dimColor>
          {sourceCount === 0 ? "no log files configured" : "loading…"}
        </Text>
      ) : (
        layout.blocks.map((block) => (
          <Box flexDirection="column" key={`${block.tag} ${block.path}`}>
            <BlockHeader block={block} />
            {block.lines.map((line, i) => (
              <Text
                // ログ行に安定した key は無いので index で十分
                key={i}
                color={block.kind === "err" ? "red" : undefined}
                wrap="truncate-end"
              >
                {line}
              </Text>
            ))}
          </Box>
        ))
      )}
      {layout.hiddenSources > 0 ? (
        <Text dimColor>{`(+${layout.hiddenSources} sources hidden)`}</Text>
      ) : null}
    </Box>
  );
}
