import { DIFFS_TAG_NAME } from "@pierre/diffs"

// Keep an ordinary-file declaration for Windows checkouts where Git cannot materialize
// the custom-elements.d.ts symlink used by Unix workspaces.
declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      [DIFFS_TAG_NAME]: HTMLAttributes<HTMLElement>
    }
  }
}

export {}
