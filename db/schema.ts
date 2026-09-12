import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const deviceSessions = sqliteTable(
  'device_sessions',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revoked: integer('revoked').notNull().default(0),
    lastSeen: integer('last_seen'),
  },
  (t) => [index('sessions_owner').on(t.owner)],
);
export const captureRequests = sqliteTable(
  'capture_requests',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => deviceSessions.id),
    owner: text('owner').notNull(),
    patientId: text('patient_id').notNull(),
    patientName: text('patient_name').notNull(),
    category: text('category').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    state: text('state').notNull().default('pending'),
  },
  (t) => [index('requests_session_created').on(t.sessionId, t.createdAt)],
);
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    requestId: text('request_id')
      .notNull()
      .references(() => captureRequests.id),
    patientId: text('patient_id').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    objectKey: text('object_key').notNull(),
    category: text('category').notNull().default('pending'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('attachments_owner_patient').on(t.owner, t.patientId),
    index('attachments_request').on(t.requestId),
  ],
);

export const patients = sqliteTable(
  'patients',
  {
    id: text('id').notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    social_name: text('social_name'),
    dob: text('dob'),
    cpf: text('cpf'),
    rg: text('rg'),
    gender: text('gender'),
    occupation: text('occupation'),
    marital_status: text('marital_status'),
    schooling: text('schooling'),
    nationality: text('nationality'),
    phone: text('phone'),
    secondary_phone: text('secondary_phone'),
    email: text('email'),
    preferred_contact: text('preferred_contact'),
    zip_code: text('zip_code'),
    street: text('street'),
    address_number: text('address_number'),
    complement: text('complement'),
    neighborhood: text('neighborhood'),
    city: text('city'),
    state: text('state'),
    guardian_name: text('guardian_name'),
    guardian_relationship: text('guardian_relationship'),
    guardian_phone: text('guardian_phone'),
    emergency_name: text('emergency_name'),
    emergency_relationship: text('emergency_relationship'),
    emergency_phone: text('emergency_phone'),
    insurance: text('insurance'),
    insurance_number: text('insurance_number'),
    referral_source: text('referral_source'),
    admin_notes: text('admin_notes'),
    search_text: text('search_text').notNull(),
    version: integer('version').notNull().default(1),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.id] }),
    uniqueIndex('patients_owner_cpf').on(t.owner, t.cpf),
    index('patients_owner_name').on(t.owner, t.name),
  ],
);

export const appointments = sqliteTable(
  'appointments',
  {
    id: text('id').notNull(),
    owner: text('owner').notNull(),
    patient_id: text('patient_id').notNull(),
    starts_at: integer('starts_at').notNull(),
    ends_at: integer('ends_at').notNull(),
    modality: text('modality').notNull().default('presencial'),
    status: text('status').notNull().default('scheduled'),
    admin_notes: text('admin_notes'),
    version: integer('version').notNull().default(1),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.owner, t.id] }),
    index('appointments_owner_starts_at').on(t.owner, t.starts_at),
    index('appointments_owner_patient_starts_at').on(
      t.owner,
      t.patient_id,
      t.starts_at,
    ),
  ],
);
