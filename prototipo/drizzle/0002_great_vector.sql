CREATE TABLE `appointments` (
	`id` text NOT NULL,
	`owner` text NOT NULL,
	`patient_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`modality` text DEFAULT 'presencial' NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`admin_notes` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE INDEX `appointments_owner_starts_at` ON `appointments` (`owner`,`starts_at`);--> statement-breakpoint
CREATE INDEX `appointments_owner_patient_starts_at` ON `appointments` (`owner`,`patient_id`,`starts_at`);