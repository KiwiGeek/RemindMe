-- App settings (single-row), admin flag, SQLite KV for Node/Docker.
ALTER TABLE `users` ADD `is_admin` integer DEFAULT 0 NOT NULL;

CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL DEFAULT 1,
	`setup_completed_at` text,
	`app_name` text NOT NULL DEFAULT 'Remind Me',
	`site_origin` text NOT NULL DEFAULT '',
	`mailgun_region` text NOT NULL DEFAULT 'us',
	`mailgun_domain` text NOT NULL DEFAULT '',
	`mailgun_from` text NOT NULL DEFAULT '',
	`mailgun_reply_to` text NOT NULL DEFAULT '',
	`mailgun_api_key_enc` text NOT NULL DEFAULT '',
	`mailgun_signing_key_enc` text NOT NULL DEFAULT '',
	`session_secret_enc` text NOT NULL DEFAULT '',
	`otp_pepper_enc` text NOT NULL DEFAULT '',
	`action_token_secret_enc` text NOT NULL DEFAULT '',
	`registration_mode` text NOT NULL DEFAULT 'open',
	`updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE `kv_entries` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer
);
CREATE INDEX `idx_kv_expires` ON `kv_entries` (`expires_at`);
