-- Add article_url dimension to analytics tables
ALTER TABLE public.analytics_impressions
    ADD COLUMN article_url text;

ALTER TABLE public.analytics_events
    ADD COLUMN article_url text;
