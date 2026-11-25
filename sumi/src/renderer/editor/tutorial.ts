export const TUTORIAL_TEXT = `Sumi チュートリアル (q で閉じる)
=====================================

Sumi は Emacs 流のキー操作で動くエディタです。C- は Ctrl、M- は Alt を押しながら。
困ったら C-g で中断、M-x でコマンド名を直接実行、C-h b で全キー一覧。

基本の移動と編集 (CodeMirror の Emacs レイヤー)
  C-f / C-b / C-n / C-p   1文字・1行ずつ移動        M-f / M-b   単語単位
  C-a / C-e               行頭・行末                 M-< / M->   バッファ先頭・末尾
  C-v / M-v               ページ送り                 C-l         再センタリング
  C-SPC                   マーク (選択開始)          C-x C-x     ポイントとマーク交換
  C-w / M-w / C-y / M-y   切り取り / コピー / 貼り付け / キルリング巡回
  C-k                     行末まで切り取り           M-d / M-DEL 単語削除
  C-/ (C-x u)             取り消し                   C-?         やり直し
  M-;                     コメント切り替え           M-/         単語補完
  C-u 数字                繰り返し回数 (例 C-u 8 C-n)

ファイルとバッファ
  C-x C-f   ファイルを開く (TAB で補完)   C-x C-s   保存         C-x C-w   名前を付けて保存
  C-x b     バッファ切り替え              C-x C-b   バッファ一覧 C-x k     バッファを閉じる
  C-x d     Dired (ディレクトリ閲覧)      C-x C-c   終了

ウィンドウ
  C-x 2   上下に分割   C-x 3   左右に分割   C-x o   次のウィンドウ
  C-x 0   このウィンドウを閉じる   C-x 1   このウィンドウだけにする

検索
  C-s / C-r   インクリメンタルサーチ (入力中に C-s でさらに次へ、RET で確定、C-g で戻る)
  M-%         置換パネル     M-g g   行番号へジャンプ

キーボードマクロ / 評価 / シェル
  C-x ( ... C-x )   マクロ記録     C-x e   実行
  M-:               JavaScript 式を評価    C-x C-e   行 (または選択範囲) を評価
  *scratch* バッファでは C-j で評価結果を挿入
  M-!               シェルコマンド実行     M-|   選択範囲をコマンドに通して置き換え

Claude
  最初に M-x claude-set-api-key で API キーを登録します (Windows の DPAPI で暗号化保存)。
  C-c c     *Claude* バッファでチャット。末尾に書いて C-c C-c で送信、C-c C-k で中断
  C-c a     選択範囲 (または現バッファ) について質問
  C-c e     選択範囲のコードを説明
  C-c r     選択範囲を指示どおりに書き換え (結果で置換)
  C-c i     カーソル位置にコードを補完して挿入
  C-c n     新しい会話を始める      C-c m   モデル変更      C-c t   ツール利用の ON/OFF
  Claude は list_buffers / read_buffer / edit_buffer / open_file などのツールで
  エディタ内のバッファを直接読み書きできます。シェル実行だけは毎回 y/n で確認します。

外観
  M-x toggle-theme   ダーク/ライト     C-x C-+ / C-x C--   文字サイズ
  M-x toggle-line-numbers   M-x toggle-truncate-lines
`;
