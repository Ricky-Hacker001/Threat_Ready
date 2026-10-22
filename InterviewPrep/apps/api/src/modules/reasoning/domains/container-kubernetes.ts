import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * Container & Kubernetes Security: cluster trust boundaries, workload identity, images and runtime.
 * The diagram is a cluster and its surroundings; the attack moves from a workload to the control
 * plane, the node, or the cloud via a mounted token, a privileged pod, or a trust.
 */
export const CONTAINER_KUBERNETES: ReasoningDomain = {
  key: 'container_kubernetes',
  title: 'Container & Kubernetes Security',
  description: 'Read a Kubernetes architecture with a compromised workload, decide which escalation path, identity or control the attack depends on, and defend the decision with evidence from audit, admission and runtime signals.',
  track: 'Platform Security',
  difficulty: 'intermediate',
  focus: [
    'From a pod to the node, the control plane, or the cloud account',
    'RBAC, service-account tokens and workload identity to cloud roles',
    'Admission control, pod security and what each actually prevents',
    'Where cluster audit, admission and runtime telemetry would show it',
  ],
  skillIds: ['k8s.security', 'k8s.workloads', 'devsecops.container_security', 'cloudsec.iam', 'netsec.segmentation'],
  weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1610', 'Deploy Container'),
    T('T1611', 'Escape to Host'),
    T('T1613', 'Container and Resource Discovery'),
    T('T1609', 'Container Administration Command'),
    T('T1552.007', 'Unsecured Credentials: Container API'),
    T('T1528', 'Steal Application Access Token'),
    T('T1550.001', 'Use Alternate Authentication Material: Application Access Token'),
    T('T1078.004', 'Valid Accounts: Cloud Accounts'),
    T('T1098.001', 'Account Manipulation: Additional Cloud Credentials'),
    T('T1098.006', 'Account Manipulation: Additional Container Cluster Roles'),
    T('T1190', 'Exploit Public-Facing Application'),
    T('T1525', 'Implant Internal Image'),
    T('T1204.003', 'User Execution: Malicious Image'),
    T('T1046', 'Network Service Discovery'),
    T('T1496', 'Resource Hijacking'),
    T('T1552.005', 'Unsecured Credentials: Cloud Instance Metadata API'),
    T('T1053.007', 'Scheduled Task/Job: Container Orchestration Job'),
    T('T1484', 'Domain or Tenant Policy Modification'),
    T('T1562.001', 'Impair Defenses: Disable or Modify Tools'),
    T('T1537', 'Transfer Data to Cloud Account'),
  ],
  variation: {
    topologies: [
      { id: 'managed_k8s_cloud', label: 'Managed Kubernetes on a cloud provider', guide: 'A managed control plane, node pools, workload identity mapping service accounts to cloud roles, an ingress controller, a cloud database outside the cluster, and a container registry.' },
      { id: 'multi_tenant_namespaces', label: 'Multi-tenant cluster with namespace isolation', guide: 'Many teams in namespaces, shared ingress, network policies of varying completeness, a shared monitoring stack with broad read, and per-namespace RBAC.' },
      { id: 'self_managed_onprem', label: 'Self-managed cluster on-premises', guide: 'Self-hosted control-plane nodes, worker nodes, an etcd cluster, a CNI, a secrets store mounted into pods, and a bastion for kubectl.' },
      { id: 'service_mesh_cluster', label: 'Cluster with a service mesh and mTLS', guide: 'Sidecar mesh with mTLS between services, an ingress gateway, an authorization policy layer, a secrets operator, and an admin dashboard exposed internally.' },
      { id: 'ci_deployed_cluster', label: 'Cluster deployed and updated by CI', guide: 'A pipeline with cluster credentials, image pulls from a registry by mutable tag, a GitOps reconciler with cluster-admin, and a staging cluster peered to production.' },
      { id: 'edge_clusters', label: 'Fleet of small edge clusters', guide: 'Many lightweight clusters managed centrally, a central management plane with broad reach, shared base images, and intermittent connectivity.' },
      { id: 'data_platform_cluster', label: 'Data-processing cluster with cloud access', guide: 'Batch jobs as pods with workload identity to object storage, a notebook service, a scheduler, and a shared service account used by several jobs.' },
      { id: 'dmz_exposed_app', label: 'Internet-facing app on Kubernetes', guide: 'A public ingress to a web workload, an internal API tier, a database, a metadata endpoint reachable from pods, and host-path mounts on one legacy workload.' },
    ],
    entryPoints: [
      { id: 'app_rce_in_pod', label: 'A workload is compromised through an application flaw', guide: 'A public workload gives code execution inside the pod; the pod has a mounted service-account token and can reach the API server and the metadata endpoint.' },
      { id: 'mounted_sa_token', label: 'A pod’s service-account token has broad RBAC', guide: 'The token can list secrets or create pods cluster-wide; it was auto-mounted though the workload never needed the API.' },
      { id: 'privileged_pod', label: 'A privileged or host-path workload', guide: 'A workload runs privileged or mounts the host filesystem/socket, so control of the pod means control of the node.' },
      { id: 'metadata_to_cloud', label: 'Pod reaches the node’s cloud metadata endpoint', guide: 'The pod obtains the node instance role’s credentials via the metadata endpoint, which is broader than the workload’s own identity.' },
      { id: 'malicious_image', label: 'A workload runs a tampered image from a mutable tag', guide: 'A repointed tag or an implanted internal image runs in the cluster; admission did not verify the digest.' },
      { id: 'exposed_kubelet_api', label: 'A node component or dashboard is reachable without auth', guide: 'The kubelet API, a dashboard, or etcd is reachable from a workload or the network and exposes secrets or exec.' },
      { id: 'workload_identity_broad', label: 'Workload identity maps to an over-scoped cloud role', guide: 'The service account federates to a cloud role that can read secrets or assume other roles well beyond the job’s need.' },
      { id: 'ci_cluster_creds', label: 'CI holds cluster-admin credentials used from outside', guide: 'A leaked pipeline kubeconfig or token with cluster-admin is used to deploy a workload of the attacker’s choosing.' },
      { id: 'weak_network_policy', label: 'Missing network policy lets a pod reach the control plane or neighbours', guide: 'A namespace without egress/ingress policy lets a compromised pod reach the API server, etcd, or other tenants.' },
      { id: 'secret_in_env', label: 'A long-lived cloud secret is injected as an environment variable', guide: 'A pod exposes a static cloud credential in its environment, reachable once the pod is compromised.' },
    ],
    objectives: [
      { id: 'break_the_path', label: 'The single change that breaks the escalation', guide: 'Ask which one RBAC, admission, identity, network or pod-security change stops the attacker reaching the objective; distractors are good cluster practices that address a different hop or do not apply here.', question: 'Which single change most directly breaks the attack path shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'escalation_path', label: 'The path from pod to the target', guide: 'Ask which escalation path the attacker takes from the compromised pod to the node, control plane or cloud; distractors are paths that look available but are blocked by a policy, a non-privileged context or a missing token.', question: 'From the compromised pod, which path reaches the target with the fewest additional steps?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'why_control_failed', label: 'Why the existing control did not prevent it', guide: 'Ask why pod security, admission, RBAC or network policy on the diagram did not stop this; distractors blame a control not on the path or credit one that did apply.', question: 'Why did the existing control shown fail to prevent this step?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'detect_first', label: 'Where the escalation would be detected first', guide: 'Ask which signal (API-server audit log, admission decisions, runtime/eBPF alerts, cloud audit of the assumed role, network flow) would show it first; distractors exist but do not see this step.', question: 'Which telemetry source would reveal this attacker first, given the controls shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'blast_radius', label: 'The blast radius from the compromised workload', guide: 'Ask what the attacker reaches through the token’s RBAC, the node, workload identity to cloud, and reachable neighbours; distractors miss a trust edge or over-state one token’s reach.', question: 'What can the attacker now reach from the compromised workload?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'contain_now', label: 'The first containment action', guide: 'Ask for the first action that cuts the workload’s access without taking the whole cluster or every tenant down or losing runtime evidence; distractors are too broad, too narrow, or evidence-destroying.', question: 'What is the first containment action to take?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
      { id: 'priority_order', label: 'The right order of two steps under a constraint', guide: 'Ask which of two actions must come first given the constraint (for example revoke the cloud role before deleting the pod, or cordon the node before rotating the token); distractors invert the order.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
    ],
    constraints: [
      { id: 'tenant_uptime', label: 'Other tenants on the cluster must stay up', guide: 'Containment must not take the shared control plane or ingress down.' },
      { id: 'no_admission_yet', label: 'No image-digest admission policy is enforced', guide: 'Mitigation must work before admission is rolled out.' },
      { id: 'gitops_reconcile', label: 'A GitOps reconciler will revert manual cluster changes', guide: 'Direct edits may be undone; change the source or pause the reconciler.' },
      { id: 'stateful_workload', label: 'A stateful workload on the node cannot be evicted abruptly', guide: 'Node actions must respect the stateful pod.' },
      { id: 'shared_sa', label: 'Several jobs share one service account', guide: 'Rotating or restricting it affects all of them.' },
      { id: 'regulated_data', label: 'A workload processes regulated data', guide: 'Evidence preservation and notification matter.' },
      { id: 'edge_offline', label: 'Some edge clusters are intermittently offline', guide: 'Central actions may not reach every cluster at once.' },
    ],
    components: [
      'managed control plane', 'API server', 'etcd', 'worker node', 'node instance role', 'kubelet', 'pod', 'privileged pod', 'service account', 'service-account token', 'RBAC role', 'cluster role binding', 'namespace', 'network policy', 'ingress controller', 'service mesh sidecar', 'admission controller', 'pod security standard', 'image registry', 'image tag', 'image digest', 'workload identity', 'cloud role', 'metadata endpoint', 'secrets store', 'secrets operator', 'host path mount', 'CNI', 'bastion', 'GitOps reconciler', 'API-server audit log', 'runtime sensor', 'cloud audit log',
    ],
  },
  guidance: `Container & Kubernetes Security realism rules:
- Use concrete, provider-neutral names (for example "namespace payments", "serviceaccount jobs-runner", "clusterrole secrets-reader", "node pool workers-a", "image app:latest"). Never invent features that do not exist.
- The attack path must be technically valid step by step: each step uses a mounted token and its RBAC, a privileged/host-path context, the metadata endpoint, workload identity, a mutable image reference, a missing network policy or a reachable component the diagram shows. If a control on the diagram (pod security, admission, RBAC scope, network policy, digest pinning, token auto-mount disabled) would block a step, the path must go around it or the narrative must say why it did not apply.
- Be exact about scope: a service-account token grants only its RBAC; the node instance role is usually broader than a workload’s own identity; a non-privileged pod cannot reach the host; admission acts at create time, not at runtime.
- Trust boundaries are real boundaries: pod, namespace, node, control plane, cluster, cloud account, registry, CI.
- The best answer must be the one an experienced platform-security engineer would choose for this exact cluster and constraint; distractors must be sound Kubernetes controls that address a different hop, do not break this path, or violate the constraint.
- Cite techniques from the ATT&CK Enterprise matrix only, favouring the Containers platform techniques and cloud credential abuse.`,
};
