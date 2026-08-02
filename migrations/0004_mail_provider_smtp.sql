-- Mail provider switch + SMTP settings (Docker/Node). Mailgun remains default.
ALTER TABLE `app_settings` ADD COLUMN `mail_provider` text NOT NULL DEFAULT 'mailgun';
ALTER TABLE `app_settings` ADD COLUMN `smtp_host` text NOT NULL DEFAULT '';
ALTER TABLE `app_settings` ADD COLUMN `smtp_port` integer NOT NULL DEFAULT 587;
ALTER TABLE `app_settings` ADD COLUMN `smtp_secure` integer NOT NULL DEFAULT 0;
ALTER TABLE `app_settings` ADD COLUMN `smtp_user` text NOT NULL DEFAULT '';
ALTER TABLE `app_settings` ADD COLUMN `smtp_pass_enc` text NOT NULL DEFAULT '';
