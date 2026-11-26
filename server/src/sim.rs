//! A simulated world's entity names, for a page that joined after the world announced them: dimos sim2 names each
//! entity once on world_observations (a "path" CborKeyValue) and answers `snapshot()` (an RPC on the sim module,
//! MujocoSim) with everything said about each entity since. Asked through the dimos gateway's CBOR mode, as
//! manipulation.rs asks the planner.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde_json::Value;

use crate::{cbor, desktop};

/// The sim modules' classes (dimos/sim2/mujoco/sim.py), any one answering snapshot().
const SIM_CLASSES: [&str; 1] = ["MujocoSim"];
const ASK: Duration = Duration::from_secs(5);

/// `snapshot()`'s answer → entity id (as text) → its path.
pub fn entity_paths(snapshot: &Value) -> BTreeMap<String, String> {
    snapshot["entities"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(id, entity)| Some((id.clone(), entity["path"].as_str()?.to_string())))
        .collect()
}

/// Every entity's path, from the running sim's snapshot().
pub async fn entities(desktop_url: &str) -> Result<BTreeMap<String, String>> {
    if desktop_url.is_empty() {
        bail!("no Desktop to reach the dimos gateway through (DIMOS_APP.desktopUrl)");
    }
    let listed = desktop::get(desktop_url, "/gateways/dimos/active/modules").await?;
    let id = listed["modules"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|module| module["class"].as_str().is_some_and(|class| SIM_CLASSES.contains(&class)))
        .and_then(|module| module["id"].as_str())
        .ok_or_else(|| anyhow!("no sim running ({} answers snapshot())", SIM_CLASSES.join(", ")))?
        .to_string();
    let path = format!("/gateways/dimos/active/modules/{id}/rpcs/snapshot");
    let reply = tokio::time::timeout(ASK, desktop::post_cbor(desktop_url, &path, &cbor::rpc_request(vec![], vec![])))
        .await
        .map_err(|_| anyhow!("the sim's snapshot() didn't answer within {} s", ASK.as_secs()))??;
    let answer = cbor::decode(&reply)?;
    if answer["ok"] != true {
        bail!("the sim's snapshot() failed: {}", answer["error"].as_str().unwrap_or("an error it couldn't describe"));
    }
    Ok(entity_paths(&answer["result"]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// cbor2.dumps({"ok": True, "result": {"ts": 5, "frame": 2, "entities": {0: {"path": "world", "backend": "mujoco"},
    /// 1: {"path": "go2", "_body": [[1.0, 2.0], [0.0]]}}}}), the gateway's CBOR reply to the sim's snapshot()
    const REPLY: &str = "a2626f6bf566726573756c74a362747305656672616d650268656e746974696573a200a2647061746865776f726c64676261636b656e64666d756a6f636f01a2647061746863676f32655f626f64798282fb3ff0000000000000fb400000000000000081fb0000000000000000";

    #[test]
    fn a_snapshot_names_each_entity_by_its_id() {
        let bytes: Vec<u8> = (0..REPLY.len()).step_by(2).map(|at| u8::from_str_radix(&REPLY[at..at + 2], 16).unwrap()).collect();
        let answer = cbor::decode(&bytes).unwrap();
        assert_eq!(answer["ok"], true);
        let paths = entity_paths(&answer["result"]);
        assert_eq!(paths, BTreeMap::from([("0".to_string(), "world".to_string()), ("1".to_string(), "go2".to_string())]));
    }
}
