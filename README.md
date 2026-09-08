# launchpeek

macOS の launchd ジョブ (LaunchAgents) を Sidekiq の管理画面のように一覧・詳細・ログ確認し、その場で kickstart / enable / disable などの操作ができるターミナルアプリ。

仕様の正は [SPEC.md](./SPEC.md)。設計判断とその理由は [docs/design.md](./docs/design.md) にまとめている。

## 起動方法

```sh
# 開発実行
bun install
bun start            # = bun run src/index.tsx

# 単一バイナリ
bun run build        # = bun run scripts/build.ts → ./launchpeek
./launchpeek
```

前提: macOS 13 以降、Bun インストール済み。user ドメイン (`gui/<uid>`) のみを扱い、sudo は不要。

## 画面

- **list**: ジョブ一覧。category / label / pid / last exit / next run / schedule 要約
- **detail**: `Enter` で開く。左に縮小一覧、右に plist パス・program・schedule・pid・state・run count 等
- **logs**: `l` で開く。stdout / stderr と[追加ログ](#追加ログファイルの設定)の末尾 200 行を、ファイルごとにブロック分けして表示し、1 秒ごとに追記を反映。各ブロックの先頭に tag (`out` / `err` / `log1`…) とパスが出る

category の色: busy=green / failed=red / disabled=gray / scheduled=cyan / idle=white

## キーバインド

| キー | 動作 |
| --- | --- |
| `j` / `k`, 矢印, `Ctrl+N` / `Ctrl+P` | 上下移動 |
| `g` / `G` | 先頭 / 末尾 |
| `Enter` | detail を開く |
| `l` | logs を開く |
| `c` / `y` | 選択中のジョブの label をクリップボードへコピー |
| `r` | kickstart (`launchctl kickstart -k`) |
| `e` / `d` | enable / disable |
| `u` | bootout (y/n 確認あり) |
| `U` | bootstrap |
| `x` | kill SIGTERM (y/n 確認あり) |
| `/` | フィルタ入力 (label 部分一致、大文字小文字無視)。`Enter` 確定、`Esc` 解除 |
| `R` | 手動再取得 |
| `q` / `Esc` | 一つ前のモードへ戻る。list では終了 (Esc はフィルタ解除が優先) |

## 追加ログファイルの設定

plist の `StandardOutPath` / `StandardErrorPath` に出てこないログファイルを、ジョブの label に紐付けて logs 画面に追加表示できる。実行スクリプトが `tee` などで独自にログを書いていて、plist 側は `/dev/null` やラッパのログしか指していないジョブ向け。

設定ファイルは `~/.config/launchpeek/config.json`。無くてもよく、その場合は従来どおり stdout / stderr だけを表示する。

```json
{
  "extraLogPaths": {
    "com.example.myjob": ["~/Library/Logs/example/myjob.log"]
  }
}
```

- キーは launchd の `Label` の**完全一致**。前方一致やワイルドカードは効かない
- 値は 1 ジョブにつき複数指定できる。表示は設定した順で `log1`, `log2`, … の tag が付く (重複や不正なパスを除いた後に採番するので、config.json の N 番目と番号が一致しないことがある。実際のパスは各ブロックのヘッダーに出る)
- パスは**絶対パス**か先頭 `~` / `~/` のみ。相対パスと `$HOME` などの変数は展開しない (シェルを経由しないため)
- stdout / stderr と同じパスを書いても二重には表示されない
- 設定を編集すると次回の一覧再取得 (通常 3 秒間隔) で反映される。再起動は不要
- 書式が不正な場合はその label だけを飛ばし、原因を logs 画面の上部に表示する。他のジョブと既存の stdout / stderr 表示には影響しない

実行ログが plist に出てこない 4 ジョブの例:

```json
{
  "extraLogPaths": {
    "jp.speee.dx-foundry.suumo-count": ["~/Library/Logs/dx-foundry/suumo-count.log"],
    "jp.speee.dx-foundry.taf-bp-call-review": ["~/Library/Logs/dx-foundry/taf-bp-call-review.log"],
    "jp.speee.dx-foundry.taf-bp-lead-status": ["~/Library/Logs/dx-foundry/taf-bp-lead-status.log"],
    "jp.speee.dx-foundry.taf-bp-lead-status-all": ["~/Library/Logs/dx-foundry/taf-bp-lead-status-all.log"]
  }
}
```

## 既知の制約

- **next run は近似**。`StartInterval` のジョブは直近の実行時刻を launchd から取得できないため、`now + interval` を表示している。実際の発火時刻とはずれる
- 一覧に出るのは `~/Library/LaunchAgents` と `/Library/LaunchAgents` に plist があるジョブのみ。`launchctl list` にしか出ないジョブ (XPC サービス、`/Library/LaunchDaemons` 等) はスコープ外
- `launchctl print` の出力形式は macOS バージョンで変わりうる。パースできない項目は `-` (undefined) になり、未知の行は無視する
- 一覧の再取得は 3 秒間隔のポーリング + LaunchAgents ディレクトリの変更検知。ログは 1 秒間隔
- ログの重複排除はパス文字列の完全一致で行う。symlink 経由で同じファイルを指す別々のパスを書いた場合は 2 ブロックに分かれて出る
- **命名規則からのログパス推測はしない**。plist に書かれていないログは設定ファイルで明示する必要がある
- 端末の行数が足りない場合、ログはソースごとに行数を配分して表示する (行数の少ないソースを優先するので、行数の多いソースは古い行から隠れる)
- バイナリ化は `bun build --compile` の CLI ではなく `scripts/build.ts` (Bun.build) を使う。ink が optional peer の `react-devtools-core` を import しており、plugin で空モジュールに差し替える必要があるため

## 検証用 demo ジョブ

60 秒ごとに `date` を stdout に書くだけのジョブを同梱している。

```sh
cp test/fixtures/com.example.launchpeek-demo.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.launchpeek-demo.plist
# ログ: /tmp/launchpeek-demo.out.log

# 片付け
launchctl bootout gui/$(id -u)/com.example.launchpeek-demo
rm ~/Library/LaunchAgents/com.example.launchpeek-demo.plist
```

## 開発

```sh
bun test             # ユニットテスト (core / state)
bunx tsc --noEmit    # 型チェック
```

CI (GitHub Actions) が PR / push で両方を実行する。

## 動作確認済み

2026-09-01、macOS 14.3.1 (Darwin 23.3) + Bun 1.3.14 で以下を確認した。

- [x] 一覧に自分の LaunchAgents (27 ジョブ、user / system 両ディレクトリ) が表示される
- [x] `r` で demo ジョブを kickstart でき、pid が表示され run count が 0 → 1 に更新される
- [x] `e` / `d` で enabled が切り替わり、category が scheduled ⇔ disabled に変わる
- [x] ログのあるジョブで `l` を押すとログが表示され、表示中の追記が 1 秒以内に反映される
- [x] plist を追加すると数秒で一覧に現れ、削除すると消える。選択中のジョブは label で追従する
- [x] `u` で y/n 確認が出て、n でキャンセル、y で bootout。`U` で bootstrap し直せる
- [x] `./launchpeek` (単一バイナリ) が起動して一覧が表示される
