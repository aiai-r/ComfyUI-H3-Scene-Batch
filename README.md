# ComfyUI-H3-Scene-Batch

個人用のH3シーン保存・バッチ実行カスタムノードです。
シーン保存は固定のノードIDと接続構成に依存しています。
任意のワークフローには対応していません。

- **H3 Scene Capture**: 直前の成功実行からプロンプト、seed、長さ、参照素材を保存します。
- **H3 Scene Batch Load**: 保存したシーンを読み込みます。
- **H3 Scene Image Path / Audio Path / Video Path**: 指定したファイルを読み込みます。

保存先は `project_dir` で指定します。`scenes.json` と参照素材が保存されます。
