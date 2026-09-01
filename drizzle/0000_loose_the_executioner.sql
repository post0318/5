CREATE TABLE `universe_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`market` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text,
	`yahoo_symbol` text,
	`group_name` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`note` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_market_symbol` ON `universe_items` (`market`,`symbol`);