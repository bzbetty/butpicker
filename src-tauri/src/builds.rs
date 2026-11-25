use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Keeps `git` and `az` from flashing a console window on every poll.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The well-known Azure DevOps resource id. Every org accepts a token issued
/// against it, so there is nothing per-org to configure.
const ADO_RESOURCE: &str = "499b84ac-1321-427f-aa17-267ca6975798";
/// az tokens last about an hour; refetch well before the edge.
const TOKEN_TTL: Duration = Duration::from_secs(20 * 60);
/// Tabs poll as often as once a minute, and a new tab or focus change can ask
/// sooner. The answer costs a round trip to Azure, so serve a recent one from memory.
const BUILD_TTL: Duration = Duration::from_secs(60);
/// Latest build per definition, so a repo with a handful of pipelines still
/// answers in one request.
const MAX_PIPELINES: usize = 10;

/// Per-project build configuration, stored beside the session and passed down
/// on every poll. Everything is optional: the common case is an Azure DevOps
/// remote that already says which org, project and repo it belongs to.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BuildConfig {
    /// `None` means auto: badge on when the remote points at Azure DevOps.
    pub enabled: Option<bool>,
    /// Overrides for a repo whose remote doesn't spell the coordinates out.
    pub organization: Option<String>,
    pub project: Option<String>,
    pub repository: Option<String>,
    /// Pin specific pipeline definition ids instead of "any build of this repo".
    pub definitions: Vec<u32>,
    /// Only builds of this branch; unset means whichever branch built last.
    pub branch: Option<String>,
}

/// What the third tab badge needs.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildStatus {
    /// `off` (disabled here), `none` (nothing to watch), `error`, or one of
    /// succeeded / failed / partial / canceled / running / queued / unknown.
    pub state: String,
    /// Pipeline name, build number and branch of the build being reported.
    pub pipeline: String,
    pub number: String,
    pub branch: String,
    /// Deep link to the build; the badge opens it.
    pub url: String,
    /// ISO-8601 straight from Azure — the frontend does the "4h ago" sum.
    pub time: Option<String>,
    /// How many pipelines the repo has, for the tooltip.
    pub pipelines: usize,
    /// `Enlighten / Enlighten Internal / Job`, or empty when unresolved. The
    /// project settings sheet shows this so "auto" is legible.
    pub source: String,
    /// Set when the answer is a guess or a failure rather than a build.
    pub error: Option<String>,
}

impl BuildStatus {
    fn plain(state: &str) -> Self {
        BuildStatus {
            state: state.into(),
            ..Default::default()
        }
    }

    fn failed(source: &str, error: impl Into<String>) -> Self {
        BuildStatus {
            state: "error".into(),
            source: source.into(),
            error: Some(error.into()),
            ..Default::default()
        }
    }
}

/// Token, repo ids and recent answers, all shared across tabs: several projects
/// in the same org would otherwise each shell out to `az`.
#[derive(Default)]
pub struct Builds {
    pub(crate) inner: Mutex<Cache>,
}

#[derive(Default)]
pub(crate) struct Cache {
    token: Option<(String, Instant)>,
    /// `org/project/repo` to repository id. Stable for the life of the repo.
    repo_ids: HashMap<String, String>,
    /// Project path to its last answer, with the config it was fetched under so
    /// that editing the settings shows its effect immediately.
    latest: HashMap<String, (Instant, String, BuildStatus)>,
}

/* ----------------------------------------------------------------- remotes */

/// Org, project and repo, however they were arrived at.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Coords {
    pub(crate) org: String,
    pub(crate) project: String,
    pub(crate) repo: String,
}

impl Coords {
    pub(crate) fn label(&self) -> String {
        format!("{} / {} / {}", self.org, self.project, self.repo)
    }

    pub(crate) fn org_url(&self) -> String {
        format!("https://dev.azure.com/{}", encode(&self.org))
    }
}

/// Azure DevOps remotes in any of the shapes a clone dialog hands out:
///
/// ```text
/// https://Enlighten@dev.azure.com/Enlighten/Enlighten%20Internal/_git/Job
/// https://enlighten.visualstudio.com/DefaultCollection/Internal/_git/Job
/// git@ssh.dev.azure.com:v3/Enlighten/Enlighten Internal/Job
/// ```
pub(crate) fn parse_remote(raw: &str) -> Option<Coords> {
    let url = raw.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);

    // scp-style ssh, which has no scheme and a colon where the path starts.
    let (authority, path) = if let Some(rest) = url.strip_prefix("git@") {
        rest.split_once(':')?
    } else {
        let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
        let (authority, path) = rest.split_once('/')?;
        (authority, path)
    };

    // `Enlighten@dev.azure.com` — the username in front is noise here.
    let host = authority.rsplit('@').next()?.to_lowercase();
    let host = host.split(':').next()?.to_string();

    let segments: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(decode)
        .collect();

    // ssh remotes are `v3/{org}/{project}/{repo}` with no `_git` marker.
    if segments.first().map(String::as_str) == Some("v3") && segments.len() >= 4 {
        return Some(Coords {
            org: segments[1].clone(),
            project: segments[2].clone(),
            repo: segments[3].clone(),
        });
    }

    let git = segments.iter().position(|s| s == "_git")?;
    let project = segments.get(git.wrapping_sub(1))?.clone();
    let repo = segments.get(git + 1)?.clone();

    // dev.azure.com carries the org in the path; visualstudio.com in the host.
    let org = if host == "dev.azure.com" || host == "ssh.dev.azure.com" {
        segments.first()?.clone()
    } else if let Some(name) = host.strip_suffix(".visualstudio.com") {
        name.trim_start_matches("vs-ssh.").to_string()
    } else {
        return None;
    };

    Some(Coords {
        org,
        project,
        repo,
    })
}

pub(crate) fn git_remotes(cwd: &Path) -> Vec<(String, String)> {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd).args(["remote", "-v"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once(char::is_whitespace)?;
            let url = rest.split_whitespace().next()?;
            Some((name.to_string(), url.to_string()))
        })
        .collect()
}

/// `origin` wins when it's an Azure DevOps remote, but a repo whose `origin` is
/// elsewhere (a GitHub mirror, say) still gets its badge from whichever remote
/// does point at Azure.
fn remote_coords(cwd: &Path) -> Option<Coords> {
    let remotes = git_remotes(cwd);
    remotes
        .iter()
        .find(|(name, _)| name == "origin")
        .and_then(|(_, url)| parse_remote(url))
        .or_else(|| remotes.iter().find_map(|(_, url)| parse_remote(url)))
}

/// The project's Azure DevOps coordinates: the remote's, with any overrides
/// from the build settings on top. Overrides fill in whatever the remote didn't
/// answer, so a repo with an Azure remote but a differently named pipeline
/// project only needs the one field changed.
pub(crate) fn resolve_coords(cwd: &Path, config: &BuildConfig) -> Option<Coords> {
    let trimmed = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let detected = if cwd.is_dir() { remote_coords(cwd) } else { None };
    Some(Coords {
        org: trimmed(&config.organization).or_else(|| detected.as_ref().map(|c| c.org.clone()))?,
        project: trimmed(&config.project).or_else(|| detected.as_ref().map(|c| c.project.clone()))?,
        repo: trimmed(&config.repository).or_else(|| detected.as_ref().map(|c| c.repo.clone()))?,
    })
}

/* -------------------------------------------------------------------- auth */

pub(crate) fn az_token(cache: &Mutex<Cache>) -> Result<String, String> {
    if let Ok(guard) = cache.lock() {
        if let Some((token, fetched)) = &guard.token {
            if fetched.elapsed() < TOKEN_TTL {
                return Ok(token.clone());
            }
        }
    }

    // az is a .cmd shim, so it has to go through cmd.exe.
    let mut cmd = Command::new("cmd.exe");
    cmd.args([
        "/C",
        "az",
        "account",
        "get-access-token",
        "--resource",
        ADO_RESOURCE,
        "--query",
        "accessToken",
        "-o",
        "tsv",
    ]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let out = cmd
        .output()
        .map_err(|e| format!("could not run az: {e}"))?;
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || token.is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(stderr
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("az could not get a token — run `az login`")
            .trim()
            .to_string());
    }

    if let Ok(mut guard) = cache.lock() {
        guard.token = Some((token.clone(), Instant::now()));
    }
    Ok(token)
}

/* -------------------------------------------------------------------- http */

pub(crate) fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default()
    })
}

pub(crate) async fn get_json(url: &str, token: &str) -> Result<serde_json::Value, String> {
    let response = client()
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;

    // Azure answers an unauthenticated request with a sign-in page and a 200,
    // so the status code alone doesn't tell you the token went stale.
    if body.trim_start().starts_with('<') {
        return Err("Azure DevOps wants a sign-in — try `az login`".into());
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("not authorised for this project (needs Build: Read)".into());
    }
    if !status.is_success() {
        return Err(format!("Azure DevOps returned {}", status.as_u16()));
    }
    serde_json::from_str(&body).map_err(|e| format!("unreadable response: {e}"))
}

async fn repo_id(cache: &Mutex<Cache>, coords: &Coords, token: &str) -> Result<String, String> {
    let key = format!("{}/{}/{}", coords.org, coords.project, coords.repo);
    if let Ok(guard) = cache.lock() {
        if let Some(id) = guard.repo_ids.get(&key) {
            return Ok(id.clone());
        }
    }

    let url = format!(
        "{}/{}/_apis/git/repositories/{}?api-version=7.1",
        coords.org_url(),
        encode(&coords.project),
        encode(&coords.repo),
    );
    let value = get_json(&url, token).await?;
    let id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or("repository not found in that project")?
        .to_string();

    if let Ok(mut guard) = cache.lock() {
        guard.repo_ids.insert(key, id.clone());
    }
    Ok(id)
}

/* ------------------------------------------------------------------ builds */

struct Build {
    id: u64,
    state: &'static str,
    pipeline: String,
    number: String,
    branch: String,
    url: String,
    time: Option<String>,
}

fn map_state(status: &str, result: &str) -> &'static str {
    match status {
        "inProgress" => "running",
        "notStarted" | "postponed" => "queued",
        "completed" => match result {
            "succeeded" => "succeeded",
            "failed" => "failed",
            "partiallySucceeded" => "partial",
            "canceled" => "canceled",
            _ => "unknown",
        },
        _ => "unknown",
    }
}

/// `refs/heads/main` reads as `main` on a badge tooltip.
fn short_branch(branch: &str) -> String {
    branch
        .strip_prefix("refs/heads/")
        .or_else(|| branch.strip_prefix("refs/pull/"))
        .unwrap_or(branch)
        .to_string()
}

fn builds_url(coords: &Coords, repository: &str, config: &BuildConfig) -> String {
    let mut url = format!(
        "{}/{}/_apis/build/builds?maxBuildsPerDefinition=1&queryOrder=queueTimeDescending&api-version=7.1",
        coords.org_url(),
        encode(&coords.project),
    );
    if config.definitions.is_empty() {
        // Every pipeline that builds this repo, rather than a list to maintain.
        url.push_str(&format!(
            "&repositoryId={repository}&repositoryType=TfsGit&$top={MAX_PIPELINES}"
        ));
    } else {
        let ids: Vec<String> = config.definitions.iter().map(u32::to_string).collect();
        url.push_str(&format!("&definitions={}", ids.join(",")));
    }
    if let Some(branch) = config.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        let full = if branch.starts_with("refs/") {
            branch.to_string()
        } else {
            format!("refs/heads/{branch}")
        };
        url.push_str(&format!("&branchName={}", encode(&full)));
    }
    url
}

fn parse_builds(value: &serde_json::Value) -> Vec<Build> {
    let Some(items) = value.get("value").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let text = |node: &serde_json::Value, key: &str| {
        node.get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    let mut builds: Vec<Build> = items
        .iter()
        .map(|item| Build {
            id: item.get("id").and_then(serde_json::Value::as_u64).unwrap_or_default(),
            state: map_state(&text(item, "status"), &text(item, "result")),
            pipeline: item
                .get("definition")
                .map(|d| text(d, "name"))
                .unwrap_or_default(),
            number: text(item, "buildNumber"),
            branch: short_branch(&text(item, "sourceBranch")),
            url: item
                .get("_links")
                .and_then(|l| l.get("web"))
                .map(|w| text(w, "href"))
                .unwrap_or_default(),
            // A running build has no finish time, and a queued one hasn't
            // started either, so fall back through to when it was asked for.
            time: ["finishTime", "startTime", "queueTime"]
                .iter()
                .map(|key| text(item, key))
                .find(|v| !v.is_empty()),
        })
        .collect();

    // Newest first, so "the latest build" is just the head of the list.
    builds.sort_by(|a, b| b.time.cmp(&a.time));
    builds
}

/// Builds held at a pipeline approval in this project, with who can approve
/// each (identity ids). One request covers every pipeline in the project; on
/// any failure the answer is simply "none waiting".
pub(crate) async fn pending_approvals(
    org_url: &str,
    project: &str,
    token: &str,
) -> HashMap<u64, Vec<String>> {
    let url = format!(
        "{org_url}/{}/_apis/pipelines/approvals?state=pending&$expand=steps&top=200&api-version=7.1",
        encode(project),
    );
    let Ok(value) = get_json(&url, token).await else {
        return HashMap::new();
    };
    let list = value.get("value").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let mut waiting: HashMap<u64, Vec<String>> = HashMap::new();
    for approval in list {
        let Some(build) = approval
            .get("pipeline")
            .and_then(|p| p.get("owner"))
            .and_then(|o| o.get("id"))
            .and_then(serde_json::Value::as_u64)
        else {
            continue;
        };
        let approvers = approval
            .get("steps")
            .and_then(serde_json::Value::as_array)
            .map(|steps| {
                steps
                    .iter()
                    .filter(|s| s.get("status").and_then(serde_json::Value::as_str) == Some("pending"))
                    .filter_map(|s| s.get("assignedApprover")?.get("id")?.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        waiting.entry(build).or_default().extend(approvers);
    }
    waiting
}

/* ----------------------------------------------------------------- command */

async fn fetch(cache: &Mutex<Cache>, coords: &Coords, config: &BuildConfig) -> BuildStatus {
    let source = coords.label();
    let token = match az_token(cache) {
        Ok(token) => token,
        Err(e) => return BuildStatus::failed(&source, e),
    };

    let repository = if config.definitions.is_empty() {
        match repo_id(cache, coords, &token).await {
            Ok(id) => id,
            Err(e) => return BuildStatus::failed(&source, e),
        }
    } else {
        String::new()
    };

    let value = match get_json(&builds_url(coords, &repository, config), &token).await {
        Ok(value) => value,
        Err(e) => return BuildStatus::failed(&source, e),
    };

    let mut builds = parse_builds(&value);
    // A run held at an approval gate is "in progress" to Azure, but nothing is
    // running: it's waiting on a person, often for days, and often to expire.
    if builds.iter().any(|b| b.state == "running") {
        let waiting = pending_approvals(&coords.org_url(), &coords.project, &token).await;
        for build in builds.iter_mut().filter(|b| b.state == "running") {
            if waiting.contains_key(&build.id) {
                build.state = "waiting";
            }
        }
    }
    // A red pipeline is the one worth interrupting for, even when a greener one
    // ran more recently; otherwise the newest build speaks for the repo.
    let chosen = builds
        .iter()
        .find(|b| b.state == "failed")
        .or_else(|| builds.first());
    let Some(build) = chosen else {
        return BuildStatus {
            state: "none".into(),
            source,
            error: Some("no builds for this repository".into()),
            ..Default::default()
        };
    };

    BuildStatus {
        state: build.state.into(),
        pipeline: build.pipeline.clone(),
        number: build.number.clone(),
        branch: build.branch.clone(),
        url: build.url.clone(),
        time: build.time.clone(),
        pipelines: builds.len(),
        source,
        error: None,
    }
}

/// The latest Azure DevOps build for a project, cached for a minute so the tab
/// poll can ask as often as it likes.
#[tauri::command]
pub async fn build_status(
    builds: tauri::State<'_, Builds>,
    path: String,
    config: BuildConfig,
) -> Result<BuildStatus, String> {
    if config.enabled == Some(false) {
        return Ok(BuildStatus::plain("off"));
    }

    // The config is part of the cache key: an edit in the settings sheet should
    // show its effect on the next poll, not a minute later.
    let fingerprint = serde_json::to_string(&config).unwrap_or_default();
    if let Ok(guard) = builds.inner.lock() {
        if let Some((fetched, key, status)) = guard.latest.get(&path) {
            if key == &fingerprint && fetched.elapsed() < BUILD_TTL {
                return Ok(status.clone());
            }
        }
    }

    let coords = match resolve_coords(Path::new(&path), &config) {
        Some(coords) => coords,
        None => {
            let status = if config.enabled == Some(true) {
                BuildStatus::failed("", "no Azure DevOps remote — set organisation, project and repository")
            } else {
                BuildStatus::plain("none")
            };
            if let Ok(mut guard) = builds.inner.lock() {
                guard
                    .latest
                    .insert(path, (Instant::now(), fingerprint, status.clone()));
            }
            return Ok(status);
        }
    };

    let status = fetch(&builds.inner, &coords, &config).await;
    if let Ok(mut guard) = builds.inner.lock() {
        guard
            .latest
            .insert(path, (Instant::now(), fingerprint, status.clone()));
    }
    Ok(status)
}

/* ---------------------------------------------------------------- encoding */

fn decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&segment[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn encode(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coords(remote: &str) -> Option<(String, String, String)> {
        parse_remote(remote).map(|c| (c.org, c.project, c.repo))
    }

    #[test]
    fn parses_https_remotes() {
        assert_eq!(
            coords("https://Enlighten@dev.azure.com/Enlighten/Enlighten%20Internal/_git/Job"),
            Some((
                "Enlighten".into(),
                "Enlighten Internal".into(),
                "Job".into()
            ))
        );
        assert_eq!(
            coords("https://dev.azure.com/Enlighten/Internal/_git/Job.git"),
            Some(("Enlighten".into(), "Internal".into(), "Job".into()))
        );
    }

    #[test]
    fn parses_legacy_and_ssh_remotes() {
        assert_eq!(
            coords("https://enlighten.visualstudio.com/DefaultCollection/Internal/_git/Job"),
            Some(("enlighten".into(), "Internal".into(), "Job".into()))
        );
        assert_eq!(
            coords("git@ssh.dev.azure.com:v3/Enlighten/Enlighten Internal/Job"),
            Some((
                "Enlighten".into(),
                "Enlighten Internal".into(),
                "Job".into()
            ))
        );
    }

    #[test]
    fn ignores_remotes_that_are_not_azure() {
        assert_eq!(coords("https://github.com/bzbetty/butpicker.git"), None);
        assert_eq!(coords("git@github.com:bzbetty/butpicker.git"), None);
        assert_eq!(coords("C:\\git\\mirror"), None);
    }

    /// Exactly what the settings sheet sends for an untouched project: unset
    /// fields arrive as nulls rather than being left out.
    #[test]
    fn reads_the_config_the_frontend_sends() {
        let config: BuildConfig = serde_json::from_str(
            r#"{"enabled":null,"organization":null,"project":null,
                "repository":null,"definitions":[],"branch":null}"#,
        )
        .expect("frontend config should deserialize");
        assert_eq!(config.enabled, None);
        assert!(config.definitions.is_empty());

        let pinned: BuildConfig = serde_json::from_str(
            r#"{"enabled":true,"organization":"Enlighten","definitions":[342,7],"branch":"main"}"#,
        )
        .expect("partial config should deserialize");
        assert_eq!(pinned.definitions, vec![342, 7]);
        assert_eq!(pinned.branch.as_deref(), Some("main"));
        assert_eq!(pinned.project, None);
    }

    #[test]
    fn round_trips_percent_encoding() {
        assert_eq!(decode("Enlighten%20Internal"), "Enlighten Internal");
        assert_eq!(encode("Enlighten Internal"), "Enlighten%20Internal");
    }
}
