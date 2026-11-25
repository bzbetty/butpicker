//! Your pull requests everywhere: the ones you opened and the ones waiting on
//! your review, across every Azure DevOps organisation your repos live in and
//! GitHub. Not just open or tracked projects: most forgotten PRs are in repos
//! that aren't open, or aren't even cloned.

use crate::builds::{self, Builds, Coords};
use crate::prs::{self, Check, Pr, Prs, Reviewer};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Polled with release tracking, every five minutes.
const MINE_TTL: Duration = Duration::from_secs(4 * 60 + 30);
/// Checks cost a request or two per PR, so only PRs of yours this young get
/// them. Older ones are quiet, and their checks have usually expired anyway.
const CHECK_DAYS: i64 = 60;
const MAX_PRS: usize = 100;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyPr {
    /// Stable across polls: `azure:Enlighten:7132`, `github:owner/repo#12`.
    pub key: String,
    /// `azure` or `github`.
    pub provider: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `Zendesk`, or `owner/repo`.
    pub repo: String,
    /// The Azure team project, or the GitHub owner.
    pub group: String,
    pub author: String,
    pub created: String,
    /// `mine` or `review`.
    pub role: String,
    pub draft: bool,
    pub conflicts: bool,
    /// Every blocking check and vote passes: it could be completed now.
    pub ready: bool,
    /// A build check failed.
    pub failing: bool,
    /// Whether checks were asked for at all (young PRs of yours only).
    pub checked: bool,
    pub approvals: usize,
    pub rejected: bool,
    /// The scanned project this PR's repository is cloned at, if any.
    pub local: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyPrs {
    pub prs: Vec<MyPr>,
    /// Sources that couldn't be asked (no az login, gh missing), for the panel's foot.
    pub errors: Vec<String>,
}

#[derive(Default)]
pub struct Mine {
    inner: Mutex<MineCache>,
}

#[derive(Default)]
struct MineCache {
    latest: Option<(Instant, String, MyPrs)>,
    /// Project path to what its remotes say, which doesn't change under us.
    remotes: HashMap<String, Located>,
}

#[derive(Clone, Default)]
struct Located {
    azure: Option<Coords>,
    github: Option<(String, String)>,
}

fn text(node: &Value, key: &str) -> String {
    node.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn at<'a>(node: &'a Value, path: &[&str]) -> &'a Value {
    path.iter().fold(node, |n, key| n.get(key).unwrap_or(&Value::Null))
}

fn list(value: &Value, key: &str) -> Vec<Value> {
    value.get(key).and_then(Value::as_array).cloned().unwrap_or_default()
}

fn days_since(iso: &str) -> i64 {
    chrono_free_days(iso).unwrap_or(0)
}

/// Days between an ISO-8601 UTC timestamp and now, without a date crate: the
/// civil-from-days arithmetic is a dozen lines and this is all it's for.
fn chrono_free_days(iso: &str) -> Option<i64> {
    let date = iso.get(..10)?;
    let mut parts = date.split('-').map(|p| p.parse::<i64>());
    let (y, m, d) = (parts.next()?.ok()?, parts.next()?.ok()?, parts.next()?.ok()?);
    let then = days_from_civil(y, m, d);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64
        / 86_400;
    Some(now - then)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// What a project's remotes point at, remembered per path.
fn locate(cache: &Mutex<MineCache>, path: &str) -> Located {
    if let Some(found) = cache.lock().ok().and_then(|g| g.remotes.get(path).cloned()) {
        return found;
    }
    let remotes = builds::git_remotes(Path::new(path));
    let found = Located {
        azure: remotes.iter().find_map(|(_, url)| builds::parse_remote(url)),
        github: remotes
            .iter()
            .find_map(|(_, url)| prs::parse_github(url))
            .map(|g| (g.owner, g.repo)),
    };
    if let Ok(mut guard) = cache.lock() {
        guard.remotes.insert(path.to_string(), found.clone());
    }
    found
}

/* ------------------------------------------------------------------- azure */

async fn azure_org(
    prs_state: &Prs,
    org: &str,
    token: &str,
    local: &HashMap<String, String>,
) -> Result<Vec<MyPr>, String> {
    // Any coords in the org will do for asking who you are.
    let probe = Coords {
        org: org.to_string(),
        project: String::new(),
        repo: String::new(),
    };
    let org_url = probe.org_url();
    let me = prs::azure_me(prs_state, &probe, token).await;
    if me.is_empty() {
        return Err(format!("{org}: couldn't tell who az is logged in as"));
    }
    let base = format!("{org_url}/_apis/git/pullrequests?searchCriteria.status=active&$top={MAX_PRS}&api-version=7.1");
    let (mine, review) = (
        builds::get_json(&format!("{base}&searchCriteria.creatorId={me}"), token).await,
        builds::get_json(&format!("{base}&searchCriteria.reviewerId={me}"), token).await,
    );
    let mine = mine.map_err(|e| format!("{org}: {e}"))?;
    let review = review.unwrap_or_default();

    let to_pr = |p: &Value, role: &str| -> MyPr {
        let repo = at(p, &["repository"]);
        let project = text(at(repo, &["project"]), "name");
        let repo_name = text(repo, "name");
        let number = p.get("pullRequestId").and_then(Value::as_u64).unwrap_or_default();
        let reviewers = list(p, "reviewers");
        let votes: Vec<i64> = reviewers
            .iter()
            .filter(|r| r.get("isContainer").and_then(Value::as_bool) != Some(true))
            .map(|r| r.get("vote").and_then(Value::as_i64).unwrap_or(0))
            .collect();
        let local_key = format!("azure:{}/{}/{}", org, project, repo_name).to_lowercase();
        MyPr {
            key: format!("azure:{org}:{number}"),
            provider: "azure".into(),
            number,
            title: text(p, "title"),
            url: format!(
                "{org_url}/{}/_git/{}/pullrequest/{number}",
                builds::encode(&project),
                builds::encode(&repo_name)
            ),
            repo: repo_name,
            group: project,
            author: text(at(p, &["createdBy"]), "displayName"),
            created: text(p, "creationDate"),
            role: role.into(),
            draft: p.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
            conflicts: text(p, "mergeStatus") == "conflicts",
            approvals: votes.iter().filter(|v| **v >= 5).count(),
            rejected: votes.iter().any(|v| *v < 0),
            local: local.get(&local_key).cloned(),
            ..Default::default()
        }
    };

    let mut out: Vec<MyPr> = Vec::new();
    for p in list(&mine, "value") {
        out.push(to_pr(&p, "mine"));
    }
    for p in list(&review, "value") {
        let mine_too = text(at(&p, &["createdBy"]), "id") == me;
        // Waiting on you: you're a reviewer who hasn't voted yet.
        let unvoted = list(&p, "reviewers")
            .iter()
            .any(|r| text(r, "id") == me && r.get("vote").and_then(Value::as_i64).unwrap_or(0) == 0);
        if !mine_too && unvoted {
            out.push(to_pr(&p, "review"));
        }
    }

    // Checks for your recent PRs, all at once.
    let handles: Vec<_> = out
        .iter()
        .enumerate()
        .filter(|(_, p)| p.role == "mine" && !p.draft && days_since(&p.created) <= CHECK_DAYS)
        .map(|(i, p)| {
            let source = list(&mine, "value")
                .into_iter()
                .find(|v| v.get("pullRequestId").and_then(Value::as_u64) == Some(p.number))
                .unwrap_or_default();
            let project_id = text(at(&source, &["repository", "project"]), "id");
            (
                i,
                tauri::async_runtime::spawn(prs::azure_checks(
                    org_url.clone(),
                    p.group.clone(),
                    project_id,
                    p.number,
                    token.to_string(),
                )),
            )
        })
        .collect();
    for (i, handle) in handles {
        let checks = handle.await.unwrap_or_default();
        settle(&mut out[i], checks, Vec::new());
    }
    Ok(out)
}

/// Fills in ready and failing from a PR's checks, the same way the PRs pane does.
fn settle(pr: &mut MyPr, checks: Vec<Check>, reviewers: Vec<Reviewer>) {
    pr.checked = true;
    pr.failing = checks.iter().any(|c| c.kind == "build" && c.state == "failed");
    let reviewers = if reviewers.is_empty() {
        // Azure's votes were already counted; the policy checks carry the rest.
        (0..pr.approvals)
            .map(|_| Reviewer {
                vote: prs::azure_vote(10).into(),
                ..Default::default()
            })
            .collect()
    } else {
        reviewers
    };
    pr.ready = prs::compute_ready(&Pr {
        draft: pr.draft,
        conflicts: pr.conflicts,
        checks,
        reviewers,
        ..Default::default()
    });
}

/* ------------------------------------------------------------------ github */

async fn github(prs_state: &Prs, local: &HashMap<String, String>) -> Result<Vec<MyPr>, String> {
    let token = prs::gh_token(prs_state)?;
    let search = |q: &str| {
        prs::gh_get(
            format!("https://api.github.com/search/issues?q={}&per_page=50", q.replace(' ', "+")),
            token.clone(),
        )
    };
    let (mine, review) = (
        search("is:pr is:open archived:false author:@me").await?,
        search("is:pr is:open archived:false review-requested:@me").await.unwrap_or_default(),
    );

    let to_pr = |p: &Value, role: &str| -> MyPr {
        // `https://api.github.com/repos/owner/repo`
        let full = text(p, "repository_url")
            .rsplitn(3, '/')
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("/");
        let number = p.get("number").and_then(Value::as_u64).unwrap_or_default();
        MyPr {
            key: format!("github:{full}#{number}"),
            provider: "github".into(),
            number,
            title: text(p, "title"),
            url: text(p, "html_url"),
            group: full.split('/').next().unwrap_or_default().to_string(),
            local: local.get(&format!("github:{full}").to_lowercase()).cloned(),
            repo: full,
            author: text(at(p, &["user"]), "login"),
            created: text(p, "created_at"),
            role: role.into(),
            draft: p.get("draft").and_then(Value::as_bool).unwrap_or(false),
            ..Default::default()
        }
    };

    let mut out: Vec<MyPr> = list(&mine, "items").iter().map(|p| to_pr(p, "mine")).collect();
    out.extend(list(&review, "items").iter().map(|p| to_pr(p, "review")));

    // Checks and reviews for your recent ones: the head commit first, then its runs.
    let me = prs::gh_get("https://api.github.com/user".into(), token.clone())
        .await
        .map(|v| text(&v, "login"))
        .unwrap_or_default();
    let handles: Vec<_> = out
        .iter()
        .enumerate()
        .filter(|(_, p)| p.role == "mine" && !p.draft && days_since(&p.created) <= CHECK_DAYS)
        .map(|(i, p)| {
            let api = format!("https://api.github.com/repos/{}", p.repo);
            let (number, token, me) = (p.number, token.clone(), me.clone());
            (
                i,
                tauri::async_runtime::spawn(async move {
                    let pull = prs::gh_get(format!("{api}/pulls/{number}"), token.clone()).await.ok()?;
                    let sha = text(at(&pull, &["head"]), "sha");
                    let conflicts = pull.get("mergeable_state").and_then(Value::as_str) == Some("dirty");
                    let (reviewers, checks) = prs::gh_pr_detail(api, number, sha, me, token).await;
                    Some((conflicts, reviewers, checks))
                }),
            )
        })
        .collect();
    for (i, handle) in handles {
        if let Ok(Some((conflicts, reviewers, checks))) = handle.await {
            out[i].conflicts = conflicts;
            out[i].approvals = reviewers.iter().filter(|r| r.vote == "approved").count();
            out[i].rejected = reviewers.iter().any(|r| r.vote == "rejected");
            settle(&mut out[i], checks, reviewers);
        }
    }
    Ok(out)
}

/* ----------------------------------------------------------------- command */

/// Every open PR you opened or are asked to review, wherever it lives.
/// `paths` are the scanned projects: they say which Azure organisations to ask
/// and which PRs belong to a repository you have cloned.
#[tauri::command]
pub async fn my_prs(
    mine_state: tauri::State<'_, Mine>,
    prs_state: tauri::State<'_, Prs>,
    builds_state: tauri::State<'_, Builds>,
    paths: Vec<String>,
    force: bool,
) -> Result<MyPrs, String> {
    let fingerprint = paths.join("\n");
    if !force {
        if let Some((at, key, answer)) = mine_state.inner.lock().ok().and_then(|g| g.latest.clone()) {
            if key == fingerprint && at.elapsed() < MINE_TTL {
                return Ok(answer);
            }
        }
    }
    let answer = compute(&mine_state.inner, &prs_state, &builds_state.inner, &paths).await;
    if let Ok(mut guard) = mine_state.inner.lock() {
        guard.latest = Some((Instant::now(), fingerprint, answer.clone()));
    }
    Ok(answer)
}

/// Several folders can clone one repository (`Job`, `Job-pr7738-master`); the
/// one named after the repository is the project, the rest are side checkouts.
fn claim(local: &mut HashMap<String, String>, key: String, path: &str, repo: &str) {
    let key = key.to_lowercase();
    let named = Path::new(path)
        .file_name()
        .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(repo));
    if named || !local.contains_key(&key) {
        local.insert(key, path.to_string());
    }
}

async fn compute(cache: &Mutex<MineCache>, prs_state: &Prs, builds_cache: &Mutex<builds::Cache>, paths: &[String]) -> MyPrs {
    // Remotes spell an org however the clone dialog did; Azure doesn't care,
    // and asking twice would list every PR twice.
    let mut orgs: BTreeSet<String> = BTreeSet::new();
    let mut local: HashMap<String, String> = HashMap::new();
    for path in paths {
        let found = locate(cache, path);
        if let Some(c) = &found.azure {
            if !orgs.iter().any(|o| o.eq_ignore_ascii_case(&c.org)) {
                orgs.insert(c.org.clone());
            }
            claim(&mut local, format!("azure:{}/{}/{}", c.org, c.project, c.repo), path, &c.repo);
        }
        if let Some((owner, repo)) = &found.github {
            claim(&mut local, format!("github:{owner}/{repo}"), path, repo);
        }
    }

    let mut answer = MyPrs::default();
    if !orgs.is_empty() {
        match builds::az_token(builds_cache) {
            Ok(token) => {
                for org in &orgs {
                    match azure_org(prs_state, org, &token, &local).await {
                        Ok(prs) => answer.prs.extend(prs),
                        Err(e) => answer.errors.push(e),
                    }
                }
            }
            Err(e) => answer.errors.push(format!("Azure DevOps: {e}")),
        }
    }
    match github(prs_state, &local).await {
        Ok(prs) => answer.prs.extend(prs),
        Err(e) => answer.errors.push(format!("GitHub: {e}")),
    }
    // Oldest first: the longer it's waited, the more it needs you.
    answer.prs.sort_by(|a, b| a.created.cmp(&b.created));
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_days_without_a_date_crate() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 11, 26) - days_from_civil(2026, 10, 2), 55);
        assert_eq!(days_from_civil(2024, 3, 1) - days_from_civil(2024, 2, 28), 2, "leap year");
    }

    #[test]
    fn the_folder_named_after_the_repo_wins() {
        let mut local = HashMap::new();
        claim(&mut local, "azure:E/I/Job".into(), "D:\\git\\Job-pr7738-master", "Job");
        claim(&mut local, "azure:E/I/Job".into(), "D:\\git\\Job", "Job");
        claim(&mut local, "azure:E/I/Job".into(), "D:\\git\\Job-pr7738-isolated", "Job");
        assert_eq!(local["azure:e/i/job"], "D:\\git\\Job");
    }

    #[test]
    fn ready_when_checks_pass_and_someone_approved() {
        let mut pr = MyPr {
            approvals: 1,
            ..Default::default()
        };
        let green = Check {
            kind: "build".into(),
            state: "succeeded".into(),
            blocking: true,
            ..Default::default()
        };
        settle(&mut pr, vec![green.clone()], Vec::new());
        assert!(pr.ready && !pr.failing);

        let mut red = MyPr {
            approvals: 1,
            ..Default::default()
        };
        let failed = Check {
            state: "failed".into(),
            ..green
        };
        settle(&mut red, vec![failed], Vec::new());
        assert!(!red.ready && red.failing);
    }
}

/// Live check: `MINE_PATHS="C:\git\a;C:\git\b" cargo test --lib mine::live -- --ignored --nocapture`.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live() {
        let paths: Vec<String> = std::env::var("MINE_PATHS")
            .unwrap_or_default()
            .split(';')
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect();
        let cache = Mutex::new(MineCache::default());
        let prs_state = Prs::default();
        let builds_cache = Mutex::new(builds::Cache::default());
        let out = tauri::async_runtime::block_on(compute(&cache, &prs_state, &builds_cache, &paths));
        if let Ok(path) = std::env::var("MINE_JSON") {
            std::fs::write(path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
        }
        for p in &out.prs {
            println!(
                "{:6} {:30} #{:<6} {:>4}d ready={} failing={} conflicts={} draft={} appr={} local={:?} | {}",
                p.role,
                p.repo,
                p.number,
                days_since(&p.created),
                p.ready,
                p.failing,
                p.conflicts,
                p.draft,
                p.approvals,
                p.local,
                p.title
            );
        }
        println!("errors: {:?}", out.errors);
    }
}
