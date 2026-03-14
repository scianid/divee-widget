-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.account (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  icon_url text,
  CONSTRAINT account_pkey PRIMARY KEY (id),
  CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.account_collaborator (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member'::text,
  invited_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  email text,
  CONSTRAINT account_collaborator_pkey PRIMARY KEY (id),
  CONSTRAINT account_collaborator_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.account(id),
  CONSTRAINT account_collaborator_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT account_collaborator_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id),
  CONSTRAINT account_collaborator_account_id_fkey1 FOREIGN KEY (account_id) REFERENCES public.account(id)
);
CREATE TABLE public.admin_users (
  user_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  created_by uuid,
  notes text,
  CONSTRAINT admin_users_pkey PRIMARY KEY (user_id),
  CONSTRAINT admin_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT admin_users_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id)
);
CREATE TABLE public.analytics_events (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id text NOT NULL,
  visitor_id uuid,
  session_id uuid,
  event_type text NOT NULL,
  event_label text,
  article_url text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT analytics_events_pkey PRIMARY KEY (id)
);
CREATE TABLE public.analytics_events_hourly_agg (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id text NOT NULL,
  event_type text NOT NULL,
  event_label text,
  hour_bucket timestamp with time zone NOT NULL,
  event_count bigint NOT NULL DEFAULT 0,
  unique_visitors bigint NOT NULL DEFAULT 0,
  unique_sessions bigint NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT analytics_events_hourly_agg_pkey PRIMARY KEY (id)
);
CREATE TABLE public.analytics_impressions (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id text NOT NULL,
  visitor_id uuid,
  session_id uuid,
  url text,
  referrer text,
  geo_country text,
  geo_city text,
  geo_lat double precision,
  geo_lng double precision,
  created_at timestamp with time zone DEFAULT now(),
  ip text,
  platform text,
  article_url text,
  CONSTRAINT analytics_impressions_pkey PRIMARY KEY (id)
);
CREATE TABLE public.analytics_impressions_hourly_agg (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id text NOT NULL,
  hour_bucket timestamp with time zone NOT NULL,
  platform text,
  geo_country text,
  impression_count bigint NOT NULL DEFAULT 0,
  unique_visitors bigint NOT NULL DEFAULT 0,
  unique_sessions bigint NOT NULL DEFAULT 0,
  unique_urls bigint NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT analytics_impressions_hourly_agg_pkey PRIMARY KEY (id)
);
CREATE TABLE public.article (
  url text NOT NULL,
  title text NOT NULL,
  content text,
  cache jsonb,
  project_id text NOT NULL,
  unique_id text NOT NULL UNIQUE,
  image_url text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT article_pkey PRIMARY KEY (unique_id)
);
CREATE TABLE public.contact_submissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  company_name text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  CONSTRAINT contact_submissions_pkey PRIMARY KEY (id)
);
CREATE TABLE public.conversation_analysis (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL UNIQUE,
  project_id text NOT NULL,
  interest_score integer CHECK (interest_score >= 0 AND interest_score <= 100),
  engagement_score numeric,
  business_score numeric,
  content_score numeric,
  sentiment_score numeric,
  ai_summary text,
  key_insights jsonb,
  analyzed_at timestamp with time zone NOT NULL DEFAULT now(),
  analysis_version character varying,
  CONSTRAINT conversation_analysis_pkey PRIMARY KEY (id),
  CONSTRAINT conversation_analysis_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id)
);
CREATE TABLE public.conversation_percentiles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id text NOT NULL,
  date date NOT NULL,
  messages_p10 integer,
  messages_p25 integer,
  messages_p50 integer,
  messages_p75 integer,
  messages_p90 integer,
  messages_p99 integer,
  duration_p10 integer,
  duration_p25 integer,
  duration_p50 integer,
  duration_p75 integer,
  duration_p90 integer,
  duration_p99 integer,
  questions_p10 integer,
  questions_p25 integer,
  questions_p50 integer,
  questions_p75 integer,
  questions_p90 integer,
  questions_p99 integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT conversation_percentiles_pkey PRIMARY KEY (id)
);
CREATE TABLE public.conversation_tags (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  tag character varying NOT NULL,
  confidence numeric,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT conversation_tags_pkey PRIMARY KEY (id),
  CONSTRAINT conversation_tags_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id)
);
CREATE TABLE public.conversations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id text NOT NULL,
  article_unique_id text NOT NULL,
  visitor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  article_title text NOT NULL,
  article_content text NOT NULL,
  messages jsonb DEFAULT '[]'::jsonb,
  started_at timestamp with time zone DEFAULT now(),
  last_message_at timestamp with time zone DEFAULT now(),
  message_count integer DEFAULT 0,
  total_chars integer DEFAULT 0,
  suggestion_index integer DEFAULT 0,
  analyzed_at timestamp with time zone,
  url text,
  CONSTRAINT conversations_pkey PRIMARY KEY (id),
  CONSTRAINT conversations_article_unique_id_fkey FOREIGN KEY (article_unique_id) REFERENCES public.article(unique_id)
);
CREATE TABLE public.dashboard_metrics (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id text NOT NULL,
  metric_date date NOT NULL,
  metric_type character varying NOT NULL,
  numeric_value numeric,
  json_value jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_metrics_pkey PRIMARY KEY (id)
);
CREATE TABLE public.freeform_qa (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id text NOT NULL,
  article_unique_id text NOT NULL,
  visitor_id uuid,
  session_id uuid,
  question text NOT NULL,
  answer text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT freeform_qa_pkey PRIMARY KEY (id),
  CONSTRAINT freeform_qa_article_unique_id_fkey FOREIGN KEY (article_unique_id) REFERENCES public.article(unique_id)
);
CREATE TABLE public.project (
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  direction USER-DEFINED NOT NULL,
  language text NOT NULL,
  icon_url text,
  client_name text NOT NULL,
  client_description text,
  highlight_color ARRAY,
  show_ad boolean NOT NULL,
  input_text_placeholders ARRAY NOT NULL,
  project_id text NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  allowed_urls ARRAY,
  account_id uuid DEFAULT gen_random_uuid(),
  display_mode USER-DEFINED NOT NULL DEFAULT 'anchored'::display_mode,
  display_position USER-DEFINED NOT NULL DEFAULT 'bottom-right'::display_position,
  article_class text DEFAULT '.article'::text,
  widget_container_class text,
  override_mobile_container_selector text,
  CONSTRAINT project_pkey PRIMARY KEY (project_id),
  CONSTRAINT project_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.account(id)
);
CREATE TABLE public.project_config (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id text NOT NULL UNIQUE,
  ad_tag_id text,
  ad_tag_id_locked boolean DEFAULT false,
  ad_tag_id_updated_at timestamp with time zone,
  ad_tag_id_updated_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  deleted_by uuid,
  revenue_share_percentage integer NOT NULL DEFAULT 50 CHECK (revenue_share_percentage >= 0 AND revenue_share_percentage <= 100),
  override_mobile_ad_size text,
  override_desktop_ad_size text,
  CONSTRAINT project_config_pkey PRIMARY KEY (id),
  CONSTRAINT project_config_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.project(project_id),
  CONSTRAINT project_config_ad_tag_id_updated_by_fkey FOREIGN KEY (ad_tag_id_updated_by) REFERENCES auth.users(id),
  CONSTRAINT project_config_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES auth.users(id)
);
CREATE TABLE public.token_usage (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  project_id text NOT NULL,
  conversation_id uuid,
  visitor_id uuid,
  session_id uuid,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer DEFAULT (input_tokens + output_tokens),
  model text,
  endpoint text,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT token_usage_pkey PRIMARY KEY (id)
);