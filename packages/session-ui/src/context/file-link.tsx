import { createContext, useContext } from "solid-js"

// The host owns path validation and navigation; Markdown only offers an optional action.
export const FileLinkContext = createContext<(path: string, encoded?: boolean) => void>()
export const useFileLink = () => useContext(FileLinkContext)
