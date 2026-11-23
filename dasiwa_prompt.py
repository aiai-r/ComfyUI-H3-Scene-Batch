class H3DaSiWaPrompt:
    """Japanese instruction for DaSiWa's MiniMaxH3 Director.

    The browser writes the LLM prompt into the Director before queueing; the
    node itself has no outputs and never runs on the server.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "enabled": ("BOOLEAN", {"default": True, "tooltip": "ONなら実行時にLLMでPromptを作り、DirectorのPrompt欄に書き込んでから生成します。"}),
            "instruction": ("STRING", {"default": "", "multiline": True, "tooltip": "作りたい動画の日本語指示。画像1・音声1はDirectorに入れた順の番号です。"}),
            "batch_folder": ("STRING", {"default": "", "tooltip": "一括実行するバッチ用フォルダの名前、または絶対パス。"}),
            "record_name": ("STRING", {"default": "", "tooltip": "生成の記録を保存する一覧の名前。作品ごとに変えると記録が分かれます。"}),
            "record": ("BOOLEAN", {"default": True, "tooltip": "ONなら生成のたびに、記録名のフォルダへ記録とプレビュー動画を保存します。"}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "H3 Scene Batch"

    def noop(self, enabled, instruction, batch_folder="", record_name="", record=True):
        return ()
