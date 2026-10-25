/**
 * Known JDBC vendors and the connection strings they expect.
 *
 * Presets only prefill the form: NetCatty never downloads driver jars itself
 * (vendor licences differ), but the hint points at the official download page.
 */

export interface JdbcPreset {
  id: string;
  label: string;
  driverClass: string;
  urlTemplate: string;
  /** Official driver download page, shown as a hint in the editor. */
  downloadUrl: string;
  defaultPort?: number;
}

export const JDBC_PRESETS: readonly JdbcPreset[] = [
  {
    id: 'mysql',
    label: 'MySQL',
    driverClass: 'com.mysql.cj.jdbc.Driver',
    urlTemplate: 'jdbc:mysql://{host}:{port}/{database}',
    downloadUrl: 'https://dev.mysql.com/downloads/connector/j/',
    defaultPort: 3306,
  },
  {
    id: 'mariadb',
    label: 'MariaDB',
    driverClass: 'org.mariadb.jdbc.Driver',
    urlTemplate: 'jdbc:mariadb://{host}:{port}/{database}',
    downloadUrl: 'https://mariadb.com/downloads/connectors/',
    defaultPort: 3306,
  },
  {
    id: 'postgresql',
    label: 'PostgreSQL',
    driverClass: 'org.postgresql.Driver',
    urlTemplate: 'jdbc:postgresql://{host}:{port}/{database}',
    downloadUrl: 'https://jdbc.postgresql.org/download/',
    defaultPort: 5432,
  },
  {
    id: 'oracle',
    label: 'Oracle',
    driverClass: 'oracle.jdbc.OracleDriver',
    urlTemplate: 'jdbc:oracle:thin:@//{host}:{port}/{database}',
    downloadUrl: 'https://www.oracle.com/database/technologies/appdev/jdbc-downloads.html',
    defaultPort: 1521,
  },
  {
    id: 'sqlserver',
    label: 'SQL Server',
    driverClass: 'com.microsoft.sqlserver.jdbc.SQLServerDriver',
    urlTemplate: 'jdbc:sqlserver://{host}:{port};databaseName={database};encrypt=true;trustServerCertificate=true',
    downloadUrl: 'https://learn.microsoft.com/sql/connect/jdbc/download-microsoft-jdbc-driver-for-sql-server',
    defaultPort: 1433,
  },
  {
    id: 'h2',
    label: 'H2 (memory)',
    driverClass: 'org.h2.Driver',
    urlTemplate: 'jdbc:h2:mem:{database}',
    downloadUrl: 'https://h2database.com/html/download.html',
  },
  {
    id: 'clickhouse',
    label: 'ClickHouse',
    driverClass: 'com.clickhouse.jdbc.ClickHouseDriver',
    urlTemplate: 'jdbc:clickhouse://{host}:{port}/{database}',
    downloadUrl: 'https://clickhouse.com/docs/integrations/language-clients/java/jdbc',
    defaultPort: 8123,
  },
  {
    id: 'dm',
    label: '达梦 DM',
    driverClass: 'dm.jdbc.driver.DmDriver',
    urlTemplate: 'jdbc:dm://{host}:{port}',
    downloadUrl: 'https://www.dameng.com/',
    defaultPort: 5236,
  },
  {
    id: 'kingbase',
    label: '人大金仓 KingbaseES',
    driverClass: 'com.kingbase8.Driver',
    urlTemplate: 'jdbc:kingbase8://{host}:{port}/{database}',
    downloadUrl: 'https://www.kingbase.com.cn/',
    defaultPort: 54321,
  },
];

export function findJdbcPreset(id: string | undefined): JdbcPreset | undefined {
  if (!id) return undefined;
  return JDBC_PRESETS.find((preset) => preset.id === id);
}

export function applyJdbcPresetTemplate(
  preset: JdbcPreset,
  values: { host?: string; port?: number; database?: string },
): string {
  const database = values.database?.trim() || 'mydb';
  return preset.urlTemplate
    .replace('{host}', values.host?.trim() || '127.0.0.1')
    .replace('{port}', String(values.port ?? preset.defaultPort ?? ''))
    .replace('{database}', database);
}
