function isTransientError(error: any): boolean {
  const msg: string = error?.message ?? "";
  return msg.includes("connection reset") ||
    msg.includes("connection refused") ||
    msg.includes("network error") ||
    msg.includes("Failed to fetch");
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 100,
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (!isTransientError(err) || attempt === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

export function getProjectById(projectId: string, supabase: any) {
  // L-3 fix: select only the columns consumed by edge functions; exclude
  // internal fields (account_id, created_at) that are never read by callers.
  return withRetry(async () => {
    const { data: project, error: projectError } = await supabase
      .from("project")
      .select(
        "project_id, allowed_urls, direction, language, icon_url, client_name, client_description, highlight_color, show_ad, input_text_placeholders, display_mode, display_position, article_class, widget_container_class, override_mobile_container_selector, disclaimer_text, widget_mode, ask_concent",
      )
      .eq("project_id", projectId)
      .single();

    if (projectError) {
      console.error("suggestions: project lookup error", projectError);
      throw projectError;
    }

    return project;
  });
}

export function getProjectConfigById(projectId: string, supabase: any) {
  // L-3 fix: select only the columns returned to the widget (ad_tag_id and
  // ad size overrides); exclude commercial/audit fields (revenue_share_percentage,
  // ad_tag_id_locked, deleted_at, deleted_by, ad_tag_id_updated_by/at).
  return withRetry(async () => {
    const { data: projectConfig, error: projectConfigError } = await supabase
      .from("project_config")
      .select(
        "project_id, ad_tag_id, override_mobile_ad_size, override_desktop_ad_size, white_label",
      )
      .eq("project_id", projectId)
      .single();

    if (projectConfigError) {
      // Return null if no config found (not all projects have config)
      if (projectConfigError.code === "PGRST116") {
        return null;
      }
      console.error("project_config lookup error", projectConfigError);
      throw projectConfigError;
    }

    return projectConfig;
  });
}
