# Markdown Viewer

専用の `content/` にコピーした Markdown を、ファイルツリーとタブで読むためのツール。起動時に Chrome のアプリウィンドウを開く。選択した文章のマーカーはコピーにだけ保存し、元ファイルは変更しない。ビルドは不要。

ローカルの本人利用を対象とする。サーバーとリバースプロキシはループバックだけで待ち受け、外部公開しない。コピー元など `content/` 外のファイルは開けず、ブラウザーのファイル選択・ドロップによる取り込みも行わない。

## 利用する

- 初回は[必要環境と依存関係の準備](docs/development.md#準備)を済ませ、[起動手順](docs/usage.md#起動)に従う。
- [コピーの作成・更新・削除](docs/usage.md#コピーの管理)
- [起動時の表示範囲とポート変更](docs/usage.md#起動オプション)
- [ファイルの開き方と相対リンクの範囲](docs/usage.md#ファイルを開く)
- [閲覧操作・ショートカット・マーカーの保存](docs/usage.md#読む操作する)
- [対応する Markdown・画像とサイズ上限](docs/usage.md#対応範囲と制限)
- [生 HTML の利用条件と起動方法](docs/usage.md#生-html-を表示する場合)

## 開発・保守する

- [開発環境の準備](docs/development.md#準備)・[自動再起動付きの開発サーバー](docs/development.md#開発サーバー)
- [Caddy を別途起動する構成](docs/development.md#任意の構成-ポート番号なしのローカル-url)
- [検証手順](docs/development.md#検証)・[構成と依存の方針](docs/development.md#構成と依存の方針)
- [安全設計と変更時に維持する条件](docs/security.md)
- [エージェント向け作業指示](AGENTS.md)
