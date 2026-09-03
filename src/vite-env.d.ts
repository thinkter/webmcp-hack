/// <reference types="vite/client" />
/// <reference types="@mcp-b/webmcp-types" />

interface ImportMetaEnv {
  readonly VITE_ROOM_SERVER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
