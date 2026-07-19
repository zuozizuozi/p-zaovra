import path from "path"

process.env.ZAOVRA_DB = ":memory:"
process.env.ZAOVRA_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.ZAOVRA_DISABLE_MODELS_FETCH = "true"
