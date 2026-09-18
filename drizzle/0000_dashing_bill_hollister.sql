CREATE TABLE `relay_pools` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL
);
