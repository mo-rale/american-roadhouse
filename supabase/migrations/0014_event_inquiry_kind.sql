-- Event and gathering requests are stored as inquiries of their own kind.
-- (Adding an enum value must be committed before it is used, so this is its own migration.)
alter type public.inquiry_kind add value if not exists 'event';
