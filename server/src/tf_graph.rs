//! tf as dimos now has it, for the recorder: an edge per (parent, child) pair, a frame may have several parents (its
//! hardware parent from a module's USD and an estimate such as odom → base), and one path between any two frames. A
//! file's reader (Foxglove, a ROS tool) wants one parent per frame, so the recorder writes a re-rooted copy: each
//! group of frames hung from its nav root (world, map, odom, else a frame nothing is published under), every edge
//! oriented away from it (an edge walked against its published direction is inverted), an edge closing a second path
//! left out. The frontend's core/tf.ts does the same for the view.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::msgs::{Header, TfEdge, TF_FINGERPRINT};

/// Frames taken as the world, in preference order, when picking a group's root.
pub const WORLD_NAMES: [&str; 3] = ["world", "map", "odom"];

#[derive(Clone, Debug, PartialEq)]
pub struct Edge {
    pub parent: String,
    pub child: String,
    pub stamp_sec: i32,
    pub stamp_nsec: i32,
    pub translation: [f64; 3],
    pub rotation: [f64; 4],
    /// seen on tf_static (stays so when its HardwareModule republishes it on tf)
    pub is_static: bool,
}

impl Edge {
    pub fn from_tf(edge: &TfEdge, is_static: bool) -> Self {
        Edge {
            parent: edge.header.frame_id.clone(),
            child: edge.child.clone(),
            stamp_sec: edge.header.stamp_sec,
            stamp_nsec: edge.header.stamp_nsec,
            translation: edge.translation,
            rotation: edge.rotation,
            is_static,
        }
    }

    /// The same transform the other way round: T_child_parent.
    pub fn inverted(&self) -> Edge {
        let [x, y, z, w] = normalized(self.rotation);
        let conjugate = [-x, -y, -z, w];
        let moved = rotate(conjugate, self.translation);
        Edge {
            parent: self.child.clone(),
            child: self.parent.clone(),
            translation: [-moved[0], -moved[1], -moved[2]],
            rotation: conjugate,
            ..self.clone()
        }
    }

    fn as_tf(&self) -> TfEdge {
        TfEdge {
            header: Header { stamp_sec: self.stamp_sec, stamp_nsec: self.stamp_nsec, frame_id: self.parent.clone() },
            child: self.child.clone(),
            translation: self.translation,
            rotation: self.rotation,
        }
    }
}

fn normalized([x, y, z, w]: [f64; 4]) -> [f64; 4] {
    let length = (x * x + y * y + z * z + w * w).sqrt();
    if length < 1e-12 {
        [0.0, 0.0, 0.0, 1.0]
    } else {
        [x / length, y / length, z / length, w / length]
    }
}

/// `vector` turned by the unit quaternion `[x, y, z, w]`.
fn rotate([x, y, z, w]: [f64; 4], vector: [f64; 3]) -> [f64; 3] {
    // v + 2w (q × v) + 2 q × (q × v)
    let cross = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let axis = [x, y, z];
    let first = cross(axis, vector);
    let second = cross(axis, first);
    [0, 1, 2].map(|i| vector[i] + 2.0 * w * first[i] + 2.0 * second[i])
}

/// A frame's place in the rooted forest: its tree parent's edge, and whether that edge is walked against its published
/// direction.
#[derive(Clone, Debug)]
struct Place {
    edge: (String, String),
    flipped: bool,
}

#[derive(Default)]
pub struct TfGraph {
    edges: BTreeMap<(String, String), Edge>,
    adjacent: BTreeMap<String, BTreeSet<(String, String)>>,
    /// frame → its place in the rooted forest; rebuilt when an edge comes or goes
    rooted: Option<BTreeMap<String, Place>>,
}

impl TfGraph {
    /// Takes an edge in (a new pair re-roots the forest); returns whether it was new.
    pub fn set(&mut self, edge: Edge) -> bool {
        let key = (edge.parent.clone(), edge.child.clone());
        if edge.parent.is_empty() || edge.child.is_empty() || edge.parent == edge.child {
            return false;
        }
        if let Some(known) = self.edges.get_mut(&key) {
            let is_static = known.is_static || edge.is_static;
            *known = Edge { is_static, ..edge };
            return false;
        }
        self.adjacent.entry(edge.parent.clone()).or_default().insert(key.clone());
        self.adjacent.entry(edge.child.clone()).or_default().insert(key.clone());
        self.edges.insert(key, edge);
        self.rooted = None;
        true
    }

    pub fn is_empty(&self) -> bool {
        self.edges.is_empty()
    }

    pub fn frames(&self) -> Vec<String> {
        self.adjacent.keys().cloned().collect()
    }

    /// Every edge seen on tf_static, as published.
    pub fn static_edges(&self) -> Vec<Edge> {
        self.edges.values().filter(|edge| edge.is_static).cloned().collect()
    }

    fn other(key: &(String, String), frame: &str) -> String {
        if key.0 == frame { key.1.clone() } else { key.0.clone() }
    }

    /// Each connected group of frames, sorted.
    fn components(&self) -> Vec<Vec<String>> {
        let mut seen = BTreeSet::new();
        let mut groups = Vec::new();
        for start in self.adjacent.keys() {
            if !seen.insert(start.clone()) {
                continue;
            }
            let mut group = vec![];
            let mut queue = VecDeque::from([start.clone()]);
            while let Some(frame) = queue.pop_front() {
                for key in &self.adjacent[&frame] {
                    let other = Self::other(key, &frame);
                    if seen.insert(other.clone()) {
                        queue.push_back(other);
                    }
                }
                group.push(frame);
            }
            group.sort();
            groups.push(group);
        }
        groups
    }

    /// A group's nav root: a world-ish frame, else one nothing is published under, else its first.
    fn root_of(&self, frames: &[String]) -> String {
        WORLD_NAMES
            .iter()
            .map(|name| name.to_string())
            .find(|name| frames.contains(name))
            .or_else(|| frames.iter().find(|frame| !self.adjacent[*frame].iter().any(|key| &key.1 == *frame)).cloned())
            .unwrap_or_else(|| frames[0].clone())
    }

    /// The nav root of each group.
    pub fn roots(&self) -> Vec<String> {
        self.components().iter().map(|frames| self.root_of(frames)).collect()
    }

    /// Breadth first from each root, a static edge taken over an estimate reaching the same frame at the same depth: each
    /// frame's path to its root is a shortest one, and an edge the search doesn't take closes a second path.
    fn forest(&mut self) -> &BTreeMap<String, Place> {
        if self.rooted.is_none() {
            let mut places = BTreeMap::new();
            for root in self.roots() {
                let mut seen = BTreeSet::from([root.clone()]);
                let mut level = vec![root];
                while !level.is_empty() {
                    // each frame one step further gets the best edge any frame of this level offers it: static first
                    let mut offers: BTreeMap<String, Place> = BTreeMap::new();
                    for frame in &level {
                        for key in &self.adjacent[frame] {
                            let other = Self::other(key, frame);
                            if seen.contains(&other) {
                                continue;
                            }
                            let better = offers.get(&other).is_none_or(|offered| !self.edges[&offered.edge].is_static && self.edges[key].is_static);
                            if better {
                                offers.insert(other, Place { edge: key.clone(), flipped: &key.1 == frame });
                            }
                        }
                    }
                    level = offers.keys().cloned().collect();
                    seen.extend(level.iter().cloned());
                    places.extend(offers);
                }
            }
            self.rooted = Some(places);
        }
        self.rooted.as_ref().unwrap()
    }

    /// `edge` as the rooted forest has it: as published, inverted, or None when it closes a second path.
    pub fn oriented(&mut self, edge: &Edge) -> Option<Edge> {
        let key = (edge.parent.clone(), edge.child.clone());
        let forest = self.forest();
        if forest.get(&edge.child).is_some_and(|place| place.edge == key && !place.flipped) {
            Some(edge.clone())
        } else if forest.get(&edge.parent).is_some_and(|place| place.edge == key && place.flipped) {
            Some(edge.inverted())
        } else {
            None
        }
    }

    /// The published edges a message carried, after it was taken in, as the rooted forest has them.
    pub fn reroot(&mut self, edges: &[Edge]) -> Vec<Edge> {
        edges.iter().filter_map(|edge| self.oriented(edge)).collect()
    }

    /// The edges that close a second path between two frames.
    pub fn off_tree(&mut self) -> Vec<(String, String)> {
        let keys: Vec<(String, String)> = self.edges.keys().cloned().collect();
        let forest = self.forest();
        let used: BTreeSet<&(String, String)> = forest.values().map(|place| &place.edge).collect();
        keys.iter().filter(|key| !used.contains(key)).cloned().collect()
    }
}

/// A tf2_msgs.TFMessage, dimos's LCM layout (as msgs::decode_tf reads it).
pub fn encode_tf(edges: &[Edge]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + edges.len() * 128);
    out.extend_from_slice(&TF_FINGERPRINT);
    out.extend_from_slice(&(edges.len() as i32).to_be_bytes());
    let string = |out: &mut Vec<u8>, text: &str| {
        out.extend_from_slice(&(text.len() as u32 + 1).to_be_bytes());
        out.extend_from_slice(text.as_bytes());
        out.push(0);
    };
    for edge in edges {
        let tf = edge.as_tf();
        out.extend_from_slice(&0i32.to_be_bytes()); // seq
        out.extend_from_slice(&tf.header.stamp_sec.to_be_bytes());
        out.extend_from_slice(&tf.header.stamp_nsec.to_be_bytes());
        string(&mut out, &tf.header.frame_id);
        string(&mut out, &tf.child);
        for value in tf.translation.iter().chain(tf.rotation.iter()) {
            out.extend_from_slice(&value.to_be_bytes());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: [f64; 4] = [0.0, 0.0, 0.0, 1.0];
    const YAW90: [f64; 4] = [0.0, 0.0, std::f64::consts::FRAC_1_SQRT_2, std::f64::consts::FRAC_1_SQRT_2];

    fn edge(parent: &str, child: &str, translation: [f64; 3], rotation: [f64; 4], is_static: bool) -> Edge {
        Edge { parent: parent.into(), child: child.into(), stamp_sec: 1, stamp_nsec: 2, translation, rotation, is_static }
    }

    /// a dog in a sim: the estimate world → odom → go2/base_link and its USD's go2 → go2/base_link → go2/head
    fn dog() -> TfGraph {
        let mut graph = TfGraph::default();
        graph.set(edge("world", "odom", [0.0; 3], NONE, true));
        graph.set(edge("odom", "go2/base_link", [2.0, 0.0, 0.0], YAW90, false));
        graph.set(edge("go2", "go2/base_link", [0.0, 0.0, 0.3], NONE, true));
        graph.set(edge("go2/base_link", "go2/head", [0.3, 0.0, 0.0], NONE, true));
        graph
    }

    fn close(a: [f64; 3], b: [f64; 3]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
    }

    #[test]
    fn an_inverted_edge_undoes_the_edge() {
        let forward = edge("a", "b", [1.0, 2.0, 0.5], YAW90, false);
        let back = forward.inverted();
        assert_eq!((back.parent.as_str(), back.child.as_str()), ("b", "a"));
        // a's origin seen from b: -(1,2,0.5) turned back 90°
        assert!(close(back.translation, [-2.0, 1.0, -0.5]), "{:?}", back.translation);
        let twice = back.inverted();
        assert!(close(twice.translation, forward.translation));
    }

    #[test]
    fn a_frame_with_two_parents_is_rerooted_into_one_parent_each_from_the_nav_root() {
        let mut graph = dog();
        assert_eq!(graph.roots(), vec!["world".to_string()]);
        // the USD's root is published as go2/base_link's parent: from the world it hangs under the base, inverted
        let usd_root = graph.reroot(&[edge("go2", "go2/base_link", [0.0, 0.0, 0.3], NONE, true)]);
        assert_eq!(usd_root.len(), 1);
        assert_eq!((usd_root[0].parent.as_str(), usd_root[0].child.as_str()), ("go2/base_link", "go2"));
        assert!(close(usd_root[0].translation, [0.0, 0.0, -0.3]));
        // the others go out as published
        let kept = graph.reroot(&[edge("odom", "go2/base_link", [2.0, 0.0, 0.0], YAW90, false), edge("go2/base_link", "go2/head", [0.3, 0.0, 0.0], NONE, true)]);
        assert_eq!(kept.iter().map(|edge| (edge.parent.as_str(), edge.child.as_str())).collect::<Vec<_>>(), vec![("odom", "go2/base_link"), ("go2/base_link", "go2/head")]);
        assert!(graph.off_tree().is_empty());
    }

    #[test]
    fn an_edge_closing_a_second_path_is_left_out_and_static_edges_win_a_tie() {
        let mut graph = dog();
        // a second estimate straight from the world to the dog's top prim
        let second = edge("world", "go2", [5.0, 5.0, 0.0], NONE, false);
        assert!(graph.set(second.clone()));
        // go2/base_link is two steps from the world both ways: its USD's static edge is the one taken
        assert_eq!(graph.off_tree(), vec![("odom".to_string(), "go2/base_link".to_string())]);
        assert_eq!(graph.reroot(&[second.clone()]), vec![second]);
        assert!(graph.reroot(&[edge("odom", "go2/base_link", [2.0, 0.0, 0.0], YAW90, false)]).is_empty());
        // republished on tf, a tf_static edge stays static
        graph.set(edge("world", "odom", [0.0; 3], NONE, false));
        assert_eq!(graph.static_edges().len(), 3);
    }

    #[test]
    fn a_group_without_a_world_hangs_from_a_frame_nothing_is_published_under() {
        let mut graph = TfGraph::default();
        graph.set(edge("spot", "spot/body", [0.0; 3], NONE, true));
        graph.set(edge("spot/body", "spot/arm", [0.0; 3], NONE, true));
        graph.set(edge("map", "base", [0.0; 3], NONE, false));
        assert_eq!(graph.roots(), vec!["map".to_string(), "spot".to_string()]);
    }

    #[test]
    fn encoded_tf_reads_back() {
        let edges = vec![edge("world", "odom", [1.0, 2.0, 3.0], YAW90, false), edge("odom", "base", [0.0; 3], NONE, false)];
        let read = crate::msgs::decode_tf(&encode_tf(&edges)).unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].header.frame_id, "world");
        assert_eq!(read[0].child, "odom");
        assert_eq!((read[0].header.stamp_sec, read[0].header.stamp_nsec), (1, 2));
        assert_eq!(read[0].translation, [1.0, 2.0, 3.0]);
        assert_eq!(read[0].rotation, YAW90);
        assert_eq!(read[1].child, "base");
    }
}
