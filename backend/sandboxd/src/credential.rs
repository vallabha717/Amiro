//! Per-agent credentials derived from one master secret.
//!
//! `HMAC-SHA256(master, "amiro-agent:" + id)`, lowercase hex — the same shape
//! as OpenDots' per-Dot computer credential. The backend derives it to address
//! one agent's container; the supervisor derives it again to check the request.
//! The master itself never leaves those two processes.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// Shortest master or supervisor token either side accepts.
pub const MIN_SECRET_LEN: usize = 24;

/// The credential for `agent_id` under `master`.
pub fn agent_credential(master: &str, agent_id: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(master.as_bytes())
        .expect("HMAC accepts keys of any length");
    mac.update(b"amiro-agent:");
    mac.update(agent_id.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Constant-time equality for secrets presented by a caller.
pub fn secrets_equal(presented: &str, expected: &str) -> bool {
    presented.len() == expected.len() && bool::from(presented.as_bytes().ct_eq(expected.as_bytes()))
}

/// Whether `presented` is the credential for `agent_id`.
pub fn verify(master: &str, agent_id: &str, presented: &str) -> bool {
    secrets_equal(presented, &agent_credential(master, agent_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = "test-master-secret-0123456789abcdef";
    const A: &str = "0123456789abcdef0123456789abcdef";
    const B: &str = "fedcba9876543210fedcba9876543210";

    #[test]
    fn matches_an_independent_hmac_vector() {
        // RFC 4231 test case 2 key/data, through the same construction, guards
        // against an accidental change of the derivation.
        let mut mac = Hmac::<Sha256>::new_from_slice(b"Jefe").unwrap();
        mac.update(b"what do ya want for nothing?");
        assert_eq!(
            hex::encode(mac.finalize().into_bytes()),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(MASTER.as_bytes()).unwrap();
        mac.update(format!("amiro-agent:{A}").as_bytes());
        assert_eq!(agent_credential(MASTER, A), hex::encode(mac.finalize().into_bytes()));
    }

    #[test]
    fn each_agent_gets_its_own_credential() {
        let a = agent_credential(MASTER, A);
        assert_eq!(a.len(), 64);
        assert_ne!(a, agent_credential(MASTER, B));
        assert_ne!(a, agent_credential("another-master-secret-0123456789", A));
        assert!(verify(MASTER, A, &a));
        assert!(!verify(MASTER, B, &a));
        assert!(!verify(MASTER, A, ""));
        assert!(!verify(MASTER, A, &a[..63]));
    }
}
