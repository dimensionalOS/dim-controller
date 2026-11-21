//! A hosted run's streams (`dimos host`: every fragment pinned to its run's zenoh_domain) are at
//! `dimos-domains/<run id>/<topic>/<type>` instead of `dimos/<topic>/<type>`. The backend works in `dimos/` keys, as the
//! page does (frontend/src/core/namespace.ts): `wire` puts one into the run domain on the way out, `plain` takes it off
//! on the way in. Which domain is the bus's call (`pick`, the page's rule): the running run's id (Desktop's
//! /gateways/dimos/active) when its domain is there, none for a run outside any, else the newest domain heard.
//! dimos's RPCs (`dimos/rpc/<name>`) and Desktop's own keys are never in one.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// how long a found domain is used before it's looked for again
const FRESH_FOR: Duration = Duration::from_secs(5);
/// how long the bus is listened to for the domains on it
const LISTEN: Duration = Duration::from_millis(300);

const DOMAINS: &str = "dimos-domains/";

/// `dimos-domains/<d>/…` → d
pub fn domain_of(key: &str) -> Option<&str> {
    let (domain, rest) = key.strip_prefix(DOMAINS)?.split_once('/')?;
    (!domain.is_empty() && !rest.is_empty()).then_some(domain)
}

/// `dimos-domains/<d>/…` → `dimos/…`; anything else unchanged
pub fn plain(key: &str) -> String {
    match domain_of(key) {
        Some(domain) => format!("dimos/{}", &key[DOMAINS.len() + domain.len() + 1..]),
        None => key.to_string(),
    }
}

/// `dimos/…` → `dimos-domains/<domain>/…` (with one; Desktop's keys and dimos's RPCs stay); anything else unchanged
pub fn wire(key: &str, domain: &str) -> String {
    let special = ["dimos/events", "dimos/gateway", "dimos/rpc"]
        .iter()
        .any(|prefix| key == *prefix || key.starts_with(&format!("{prefix}/")));
    match key.strip_prefix("dimos/") {
        Some(rest) if !domain.is_empty() && !special => format!("{DOMAINS}{domain}/{rest}"),
        _ => key.to_string(),
    }
}

/// The run domain to work in: the running run's own when it's on the bus, none when a run runs outside any, else the
/// current one while it's there, or the newest (run ids start with their date and time).
pub fn pick(domains: &BTreeSet<String>, run_id: Option<&str>, current: &str) -> String {
    if let Some(run_id) = run_id.filter(|id| !id.is_empty()) {
        return if domains.contains(run_id) { run_id.to_string() } else { String::new() };
    }
    if !current.is_empty() && domains.contains(current) {
        return current.to_string();
    }
    domains.iter().next_back().cloned().unwrap_or_default()
}

/// The run domain now, looked for again every FRESH_FOR.
#[derive(Default)]
pub struct RunDomain {
    found: Mutex<Option<(String, Instant)>>,
}

impl RunDomain {
    pub async fn get(&self, session: &zenoh::Session, desktop_url: &str) -> String {
        let current = match self.found.lock().unwrap().clone() {
            Some((domain, at)) if at.elapsed() < FRESH_FOR => return domain,
            Some((domain, _)) => domain,
            None => String::new(),
        };
        let run_id = running_run_id(desktop_url).await;
        let domains = domains_on(session).await;
        let domain = pick(&domains, run_id.as_deref(), &current);
        *self.found.lock().unwrap() = Some((domain.clone(), Instant::now()));
        domain
    }
}

/// The running run's id, from Desktop (None outside Desktop, or with nothing running).
async fn running_run_id(desktop_url: &str) -> Option<String> {
    if desktop_url.is_empty() {
        return None;
    }
    let active = crate::desktop::get(desktop_url, "/gateways/dimos/active").await.ok()?;
    if active["running"].as_bool() != Some(true) {
        return None;
    }
    active["runId"].as_str().filter(|id| !id.is_empty()).map(str::to_string)
}

/// The run domains heard in a short listen.
async fn domains_on(session: &zenoh::Session) -> BTreeSet<String> {
    let found: Arc<Mutex<BTreeSet<String>>> = Arc::default();
    let sink = found.clone();
    let Ok(listener) = session
        .declare_subscriber(format!("{DOMAINS}**"))
        .callback(move |sample| {
            if let Some(domain) = domain_of(sample.key_expr().as_str()) {
                sink.lock().unwrap().insert(domain.to_string());
            }
        })
        .await
    else {
        return BTreeSet::new();
    };
    tokio::time::sleep(LISTEN).await;
    let _ = listener.undeclare().await;
    let domains = found.lock().unwrap().clone();
    domains
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_go_into_the_domain_and_back() {
        assert_eq!(wire("dimos/cmd_vel/geometry_msgs.Twist", "run1"), "dimos-domains/run1/cmd_vel/geometry_msgs.Twist");
        assert_eq!(wire("dimos/**", "run1"), "dimos-domains/run1/**");
        assert_eq!(wire("dimos/rpc/Go2/stand", "run1"), "dimos/rpc/Go2/stand");
        assert_eq!(wire("dimos/events/launch", "run1"), "dimos/events/launch");
        assert_eq!(wire("dimos/cmd_vel/geometry_msgs.Twist", ""), "dimos/cmd_vel/geometry_msgs.Twist");
        assert_eq!(wire("dimos-domains/run1/odom/nav_msgs.Odometry", "run1"), "dimos-domains/run1/odom/nav_msgs.Odometry");
        assert_eq!(plain("dimos-domains/20261120-101500-go2/odom/nav_msgs.Odometry"), "dimos/odom/nav_msgs.Odometry");
        assert_eq!(plain("dimos/odom/nav_msgs.Odometry"), "dimos/odom/nav_msgs.Odometry");
        assert_eq!(domain_of("dimos-domains/run1/odom/T.T"), Some("run1"));
        assert_eq!(domain_of("dimos-domains/run1"), None);
    }

    #[test]
    fn the_running_runs_domain_else_none_else_the_newest() {
        let domains: BTreeSet<String> = ["20261120-090000-a", "20261120-101500-go2"].map(String::from).into();
        assert_eq!(pick(&domains, Some("20261120-090000-a"), ""), "20261120-090000-a");
        assert_eq!(pick(&domains, Some("20261120-110000-plain"), "20261120-090000-a"), "");
        assert_eq!(pick(&domains, None, ""), "20261120-101500-go2");
        assert_eq!(pick(&domains, None, "20261120-090000-a"), "20261120-090000-a");
        assert_eq!(pick(&BTreeSet::new(), None, "gone"), "");
    }
}
