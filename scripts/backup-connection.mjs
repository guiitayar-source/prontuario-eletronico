// Validate destinations before passing any database credentials to pg_dump.
export function remoteConnection(apiUrl, databaseUrl, passwordOverride = '') {
  const invalid = () => new Error(
    'Use a conexão direta ou Session pooler (porta 5432) do mesmo projeto Supabase, com a senha do banco.',
  );
  let api, db, user, password;
  try {
    api = new URL(apiUrl);
    db = new URL(databaseUrl);
    user = decodeURIComponent(db.username);
    password = passwordOverride || decodeURIComponent(db.password);
  } catch {
    throw invalid();
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/.exec(api.hostname);
  if (!match || api.protocol !== 'https:' || api.username || api.password || api.port)
    throw invalid();
  const ref = match[1];
  const direct = db.hostname === `db.${ref}.supabase.co` && user === 'postgres';
  const session = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(db.hostname)
    && user === `postgres.${ref}`;
  if (!['postgres:', 'postgresql:'].includes(db.protocol)
    || (!direct && !session) || (db.port && db.port !== '5432')
    || db.pathname !== '/postgres' || !password || /[\x00-\x1f\x7f]/.test(password)
    || /\[YOUR[-_]PASSWORD\]/i.test(password) || db.hash)
    throw invalid();
  return {
    PGHOST: db.hostname,
    PGPORT: '5432',
    PGUSER: user,
    PGPASSWORD: password,
    PGDATABASE: 'postgres',
    PGSSLMODE: 'require',
    PGCONNECT_TIMEOUT: '15',
  };
}
