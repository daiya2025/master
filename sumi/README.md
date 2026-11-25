# Sumi — Windows 11 向け Emacs 流エディタ + Claude

Sumi(墨)は Emacs のキー操作で動くテキストエディタです。Electron + CodeMirror 6 で作られ、
Windows 11 用のインストーラー / ポータブル exe としてビルドできます。Claude(Anthropic API)が組み込まれており、
チャットだけでなく、ツール呼び出しでエディタ内のバッファを直接読み書きします。

## 主な機能

- **Emacs キーバインド**: `C-x C-f` `C-x C-s` `C-x b` `C-x 2/3/0/1/o` `M-x` `C-s`(isearch) `C-SPC` `C-w/M-w/C-y` キルリング、`C-u` 前置引数、`C-x (` `C-x )` `C-x e` キーボードマクロ、`M-:`/`C-x C-e` JavaScript 評価、`M-!` `M-|` シェル
- **ミニバッファ**: TAB 補完付きのファイル名・バッファ名・コマンド名入力、履歴(`M-p`/`M-n`)、`C-g` 中断。日本語 IME 対応
- **バッファ / ウィンドウ**: 複数ウィンドウ分割、`*scratch*`、`*Messages*`、`*Buffer List*`(`C-x C-b`)、Dired(`C-x d`)、`*Help*`(`C-h b`)、チュートリアル(`C-h t`)
- **言語モード**: 150 以上の言語をファイル名から自動判別してハイライト(CodeMirror language-data)
- **Claude 連携**
  - `C-c c` `*Claude*` バッファでチャット(`C-c C-c` 送信、`C-c C-k` 中断、`C-c n` 新規会話)
  - `C-c a` 選択範囲/バッファについて質問、`C-c e` コード説明、`C-c r` 指示どおり書き換え(範囲を置換)、`C-c i` カーソル位置にコード補完
  - Claude が使えるツール: `list_buffers` `read_buffer` `get_selection` `edit_buffer` `replace_buffer` `insert_at_point` `create_buffer` `open_file` `list_directory` `save_buffer` `run_shell`(毎回 y/n 確認)
  - モデル既定は `claude-opus-5-5`(`C-c m` で Sonnet 5.5 / Haiku 5.5 / Fable 5.2 などに変更)。adaptive thinking + effort、ストリーミング、サーバー側リフューザル・フォールバックを使用
  - API キーは Windows の DPAPI(`safeStorage`)で暗号化して保存。環境変数 `ANTHROPIC_API_KEY` も利用可

## セットアップ

```powershell
cd sumi
npm install
npm start          # 開発起動
npm run dist       # release/ に Sumi-<ver>-win-x64.exe (NSIS) と portable exe を生成
```

GitHub Actions(`.github/workflows/sumi-windows.yml`)でも Windows ランナー上でインストーラーがビルドされ、
`Sumi-windows` アーティファクトとしてダウンロードできます。

起動後 `M-x claude-set-api-key` で Anthropic の API キー(`sk-ant-...`)を登録すると Claude が使えます。

## テスト

```powershell
npm run typecheck
npm test           # Electron をヘッドレス起動し、擬似 Claude バックエンドでキー操作〜ツール呼び出しまで検証
```

## 構成

```
src/main/      Electron メイン: ファイル I/O、設定 + 暗号化キー保存、Claude ストリーミング(@anthropic-ai/sdk)
src/preload/   contextBridge 経由の安全な API (window.sumi)
src/renderer/  エディタ本体 (CodeMirror 6 + @replit/codemirror-emacs)、ミニバッファ、ウィンドウ木、コマンド、Claude チャット
src/shared/    IPC 型定義
```

会話の履歴はレンダラー側が保持し、Claude のツール呼び出しもレンダラーで実行します。
メインプロセスは API キーを保持して Messages API を呼ぶだけなので、キーが UI 側に渡ることはありません。
