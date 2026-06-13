/// <reference types="vite/client" />

// Allow importing files with ?url suffix
declare module '*?url' {
  const url: string;
  export default url;
}
