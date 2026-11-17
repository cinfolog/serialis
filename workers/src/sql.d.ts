// SQL migrations are bundled as text (wrangler.jsonc `rules`).
declare module '*.sql' {
  const sql: string;
  export default sql;
}
