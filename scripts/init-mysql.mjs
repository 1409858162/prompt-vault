// scripts/init-mysql.mjs
//
// Creates every table this project needs and the indexes that make the
// read paths in lib/* fast. Safe to re-run: every statement is `IF NOT EXISTS`,
// so a populated database is left untouched. Run after `npm install`:
//
//   npm run db:init
//
// Connection settings come from .env (see .env.example). The target database
// must already exist OR we connect without a database and CREATE it.

import 'dotenv/config';
import mysql from 'mysql2/promise';

const cfg = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  multipleStatements: true,
};

const DB = process.env.MYSQL_DATABASE || 'prompt_vault';

// All DDL is idempotent so re-running is a no-op.
const DDL = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id              VARCHAR(64)  NOT NULL,
    username        VARCHAR(191) NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    kind            VARCHAR(32),
    promoted_from_code VARCHAR(64) NULL,
    note            TEXT,
    membership_years INT NULL,
    activated_at    DATETIME NULL,
    expires_at      DATETIME NULL,
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NULL,
    last_login_at   DATETIME NULL,
    login_count     INT NOT NULL DEFAULT 0,
    revoked         TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_accounts_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS codes (
    id              VARCHAR(64)  NOT NULL,
    code_hash       VARCHAR(255) NOT NULL,
    label           VARCHAR(255),
    note            TEXT,
    revoked         TINYINT(1) NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL,
    updated_at      DATETIME NULL,
    last_used_at    DATETIME NULL,
    use_count       INT NOT NULL DEFAULT 0,
    login_disabled  TINYINT(1) NOT NULL DEFAULT 0,
    consumed_for_account VARCHAR(64) NULL,
    consumed_at     DATETIME NULL,
    membership_years INT NULL,
    activated_at    DATETIME NULL,
    expires_at      DATETIME NULL,
    PRIMARY KEY (id),
    KEY idx_codes_code_hash (code_hash),
    KEY idx_codes_consumed_for_account (consumed_for_account)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS user_device (
    id              VARCHAR(64)  NOT NULL,
    user_id         VARCHAR(64)  NOT NULL,
    device_id       VARCHAR(128) NOT NULL,
    device_type     VARCHAR(32),
    browser         VARCHAR(64),
    os              VARCHAR(64),
    ip              VARCHAR(64),
    country         VARCHAR(32),
    location        VARCHAR(255) NULL,
    last_active_time DATETIME,
    created_at      DATETIME,
    updated_at      DATETIME NULL,
    payload         JSON NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_user_device (user_id, device_id),
    KEY idx_user_device_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS user_session (
    id              VARCHAR(128) NOT NULL,
    jti             VARCHAR(128),
    user_id         VARCHAR(64)  NOT NULL,
    device_id       VARCHAR(128) NOT NULL,
    ip              VARCHAR(64),
    ua              TEXT,
    expires_at      DATETIME,
    revoked         TINYINT(1) NOT NULL DEFAULT 0,
    revoked_at      DATETIME NULL,
    created_at      DATETIME,
    updated_at      DATETIME NULL,
    payload         JSON NULL,
    PRIMARY KEY (id),
    KEY idx_user_session_user (user_id),
    KEY idx_user_session_device (device_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS captcha_challenge (
    id              VARCHAR(64) NOT NULL,
    answer_hash     VARCHAR(255),
    image           MEDIUMTEXT,
    sig             VARCHAR(255) NULL,
    expires_at      DATETIME,
    consumed        TINYINT(1) NOT NULL DEFAULT 0,
    consumed_at     DATETIME NULL,
    created_at      DATETIME,
    updated_at      DATETIME NULL,
    payload         JSON NULL,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS content_token (
    id              VARCHAR(128) NOT NULL,
    token_hash      VARCHAR(255),
    user_id         VARCHAR(64),
    device_id       VARCHAR(128),
    ip              VARCHAR(64),
    resource        VARCHAR(255),
    token           TEXT,
    expires_at      DATETIME,
    consumed        TINYINT(1) NOT NULL DEFAULT 0,
    consumed_at     DATETIME NULL,
    used            TINYINT(1) NOT NULL DEFAULT 0,
    used_at         DATETIME NULL,
    created_at      DATETIME,
    updated_at      DATETIME NULL,
    payload         JSON NULL,
    PRIMARY KEY (id),
    KEY idx_content_token_user (user_id),
    KEY idx_content_token_device (device_id),
    KEY idx_content_token_resource (resource)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS ip_block (
    id              VARCHAR(64) NOT NULL,
    ip              VARCHAR(64) NOT NULL,
    reason          TEXT,
    expires_at      DATETIME NULL,
    created_at      DATETIME,
    updated_at      DATETIME NULL,
    PRIMARY KEY (id),
    KEY idx_ip_block_ip (ip)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS security_event (
    id              VARCHAR(64) NOT NULL,
    ts              BIGINT,
    type            VARCHAR(128),
    payload         JSON,
    created_at      DATETIME,
    PRIMARY KEY (id),
    KEY idx_security_event_type (type),
    KEY idx_security_event_ts (ts)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS login_risk (
    id              VARCHAR(64) NOT NULL,
    ts              BIGINT,
    type            VARCHAR(128),
    user_id         VARCHAR(64),
    ip              VARCHAR(64),
    reasons         JSON,
    score           INT,
    payload         JSON,
    created_at      DATETIME,
    PRIMARY KEY (id),
    KEY idx_login_risk_user (user_id),
    KEY idx_login_risk_ts (ts)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS user_behavior_log (
    id              VARCHAR(64) NOT NULL,
    ts              BIGINT,
    user_id         VARCHAR(64),
    device_id       VARCHAR(128),
    ip              VARCHAR(64),
    path            VARCHAR(255),
    cls             VARCHAR(64),
    payload         JSON,
    created_at      DATETIME,
    PRIMARY KEY (id),
    KEY idx_user_behavior_user (user_id),
    KEY idx_user_behavior_device (device_id),
    KEY idx_user_behavior_ts (ts)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS announcements (
    id              VARCHAR(64) NOT NULL,
    kind            VARCHAR(32),
    title           VARCHAR(255),
    body            TEXT,
    enabled         TINYINT(1) NOT NULL DEFAULT 1,
    pinned          TINYINT(1) NOT NULL DEFAULT 0,
    active          TINYINT(1) NOT NULL DEFAULT 1,
    starts_at       DATETIME NULL,
    ends_at         DATETIME NULL,
    expires_at      DATETIME NULL,
    created_by      VARCHAR(64),
    created_at      DATETIME,
    updated_at      DATETIME NULL,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function main() {
  // Step 1: connect without a database so we can CREATE it if missing.
  const root = await mysql.createConnection(cfg);
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.end();
  console.log(`[init] database \`${DB}\` ensured`);

  // Step 2: connect to the target database and run all DDL.
  const conn = await mysql.createConnection({ ...cfg, database: DB, multipleStatements: false });
  for (const stmt of DDL) {
    await conn.query(stmt);
  }
  await conn.end();
  console.log(`[init] ${DDL.length} tables ensured (indexes included)`);
}

main().catch(err => {
  console.error('[init] failed:', err.message);
  process.exit(1);
});