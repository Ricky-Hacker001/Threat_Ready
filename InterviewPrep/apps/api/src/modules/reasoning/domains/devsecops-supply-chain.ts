import type { ReasoningDomain } from '../domain.types.js';

const T = (id: string, name: string) => ({ id, name });

/**
 * DevSecOps & Supply Chain: pipelines, dependencies, build integrity and deployment identities.
 * The diagram is the path from source to production; the attack rides the build, a dependency, or
 * a deployment credential.
 */
export const DEVSECOPS_SUPPLY_CHAIN: ReasoningDomain = {
  key: 'devsecops_supply_chain',
  title: 'DevSecOps & Supply Chain',
  description: 'Read a source-to-production pipeline with a supply-chain or build compromise, decide which stage, dependency or identity the attack depends on, and defend the decision with evidence from the build and deployment logs.',
  track: 'DevSecOps',
  difficulty: 'intermediate',
  focus: [
    'Where trust is placed in the path from commit to running workload',
    'Build integrity, provenance and what signing does and does not prove',
    'Deployment identities and the blast radius of a pipeline credential',
    'Dependency and artefact trust across registries and caches',
  ],
  skillIds: ['devsecops.pipeline_security', 'devsecops.supply_chain', 'devsecops.secrets_management', 'devsecops.iac_security', 'devops.ci_cd'],
  weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 },
  scoring: { partialCreditForPlausible: 0.25 },
  techniques: [
    T('T1195.001', 'Supply Chain Compromise: Compromise Software Dependencies and Development Tools'),
    T('T1195.002', 'Supply Chain Compromise: Compromise Software Supply Chain'),
    T('T1199', 'Trusted Relationship'),
    T('T1072', 'Software Deployment Tools'),
    T('T1552.001', 'Unsecured Credentials: Credentials in Files'),
    T('T1552.004', 'Unsecured Credentials: Private Keys'),
    T('T1552.007', 'Unsecured Credentials: Container API'),
    T('T1552.008', 'Unsecured Credentials: Chat Messages'),
    T('T1078.004', 'Valid Accounts: Cloud Accounts'),
    T('T1098.001', 'Account Manipulation: Additional Cloud Credentials'),
    T('T1528', 'Steal Application Access Token'),
    T('T1550.001', 'Use Alternate Authentication Material: Application Access Token'),
    T('T1584.008', 'Compromise Infrastructure: Network Devices'),
    T('T1601', 'Modify System Image'),
    T('T1546', 'Event Triggered Execution'),
    T('T1053', 'Scheduled Task/Job'),
    T('T1204.003', 'User Execution: Malicious Image'),
    T('T1203', 'Exploitation for Client Execution'),
    T('T1213.003', 'Data from Information Repositories: Code Repositories'),
    T('T1668', 'Exclusive Control'),
  ],
  variation: {
    topologies: [
      { id: 'github_actions_cloud', label: 'Git host with hosted CI deploying to the cloud via OIDC', guide: 'A source repo, a hosted CI with workflow files, OIDC federation to a cloud deploy role, an artefact registry, environments with approvals, and infrastructure as code applied by the pipeline.' },
      { id: 'self_hosted_runners', label: 'Self-hosted CI runners on the corporate network', guide: 'Persistent self-hosted runners reused across jobs, a secrets store injected at build, a container registry, a staging and a production cluster, and pull-request builds from forks.' },
      { id: 'artifact_promotion', label: 'Multi-stage artefact promotion dev to prod', guide: 'A build stage producing a signed artefact, a dependency proxy/cache, a promotion pipeline across environments, a release approver, and a deploy service with broad cloud rights.' },
      { id: 'container_build_chain', label: 'Container image build and distribution', guide: 'A base-image source, a build that installs dependencies, an image registry with tags, an admission step in the cluster, and a nightly rebuild job with registry push rights.' },
      { id: 'iac_platform', label: 'Infrastructure-as-code platform with state', guide: 'IaC modules, a remote state backend with secrets, a plan-and-apply pipeline, a privileged apply role, drift detection, and a module registry pulling community modules.' },
      { id: 'package_publishing', label: 'Internal package registry feeding many services', guide: 'A private package registry, an upstream public proxy, a publish pipeline with a signing key, consumers across teams, and a naming scheme that overlaps with public packages.' },
      { id: 'mobile_release', label: 'Mobile app build and store release', guide: 'A build pipeline with signing certificates, a dependency manager, a third-party SDK, a release pipeline to an app store, and a crash-reporting integration with broad scopes.' },
      { id: 'gitops_cluster', label: 'GitOps-driven cluster deployment', guide: 'A config repo watched by a reconciler with cluster-admin, image tags updated by automation, a secrets operator, and webhook-triggered syncs.' },
    ],
    entryPoints: [
      { id: 'dependency_takeover', label: 'A dependency the build trusts turns malicious', guide: 'A maintainer change, a hijacked package, or a dependency-confusion name resolves from the public upstream into the build; the build runs it with its own credentials.' },
      { id: 'poisoned_pr', label: 'A pull-request build from an untrusted fork runs with secrets', guide: 'A fork PR triggers a workflow that exposes secrets or runs attacker-controlled code on a shared runner.' },
      { id: 'leaked_ci_token', label: 'A CI or deploy token leaked in logs or chat', guide: 'A token with deploy rights appears in a build log or a chat message; it is used from an unfamiliar network to push an artefact or assume the deploy role.' },
      { id: 'runner_persistence', label: 'A self-hosted runner retains state between jobs', guide: 'A job leaves credentials or a modified toolchain on a reused runner that a later job inherits.' },
      { id: 'registry_tag_swap', label: 'A mutable image tag is repointed to a malicious image', guide: 'The registry allows overwriting a tag the cluster pulls; admission does not verify the digest.' },
      { id: 'iac_module_backdoor', label: 'A community IaC module adds a hidden resource', guide: 'A pulled module creates an extra admin principal or opens a path during apply, under the privileged apply role.' },
      { id: 'signing_key_exposed', label: 'A build signing key is readable by the build', guide: 'The key that proves provenance is available to ordinary jobs, so a signed-but-malicious artefact is possible.' },
      { id: 'dependency_confusion', label: 'An internal package name also exists publicly', guide: 'The resolver prefers the higher public version, pulling an attacker’s package into many services.' },
      { id: 'webhook_sync', label: 'A GitOps webhook triggers a sync from a tampered commit', guide: 'A commit to the watched config repo is reconciled to the cluster by an agent with cluster-admin.' },
      { id: 'sdk_update', label: 'A third-party SDK ships a malicious update', guide: 'A trusted SDK in the mobile or service build receives a tampered release that runs in every consumer.' },
    ],
    objectives: [
      { id: 'break_the_path', label: 'The single change that breaks the attack path', guide: 'Ask which one pipeline, trust, identity or verification change stops the compromise reaching production; distractors are good DevSecOps practices that address a different stage or do not apply here.', question: 'Which single change most directly breaks the attack path shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'where_trust_fails', label: 'Where misplaced trust let the step succeed', guide: 'Ask which trust relationship or verification gap on the diagram the step relied on; distractors blame a stage that was not on the path or a control that did apply.', question: 'Which misplaced trust or missing verification let this step succeed?', weights: { correctness: 30, reasoning: 40, architecture: 25, risk: 5 } },
      { id: 'what_signing_proves', label: 'What signing, scanning or approval does and does not prove here', guide: 'Ask which existing control (signature, SCA scan, approval gate, admission check) the attacker satisfied or bypassed and why it did not stop them; distractors credit a control with a guarantee it does not give.', question: 'Why did the existing control shown fail to stop this?', weights: { correctness: 30, reasoning: 45, architecture: 20, risk: 5 } },
      { id: 'detect_first', label: 'Where the compromise would be detected first', guide: 'Ask which log (build log, registry audit, cloud audit of the deploy role, admission log, state change) would show it first; distractors exist but do not see this step.', question: 'Which log source would reveal this attacker first, given the controls shown?', weights: { correctness: 30, reasoning: 40, architecture: 20, risk: 10 } },
      { id: 'blast_radius', label: 'The blast radius of the compromised stage or identity', guide: 'Ask what the attacker can reach through the pipeline’s credentials, the artefact’s consumers and the deployment identity; distractors miss a consumer or over-state what one token grants.', question: 'What can the attacker now reach from the compromised stage or identity?', weights: { correctness: 30, reasoning: 30, architecture: 30, risk: 10 } },
      { id: 'contain_now', label: 'The first containment action', guide: 'Ask for the first action that stops a bad artefact or credential from reaching or persisting in production without breaking every team’s ability to ship; distractors are too broad, too narrow, or leave the artefact deployable.', question: 'What is the first containment action to take?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
      { id: 'priority_order', label: 'The right order of two remediation steps under a constraint', guide: 'Ask which of two actions must come first given the constraint (for example revoke the deploy token before rebuilding, or pin the digest before re-enabling the sync); distractors invert the order.', question: 'Given the constraint, which action must come first?', weights: { correctness: 30, reasoning: 35, architecture: 15, risk: 20 } },
    ],
    constraints: [
      { id: 'release_window', label: 'A customer-committed release ships in 48 hours', guide: 'Favour actions that do not block the whole pipeline if a narrower one works.' },
      { id: 'many_consumers', label: 'The affected artefact is used by a dozen teams', guide: 'A rebuild or a block has wide impact; scope it.' },
      { id: 'no_digest_pinning', label: 'Deployments reference mutable tags, not digests', guide: 'Mitigation must work before pinning is rolled out.' },
      { id: 'shared_runner', label: 'One self-hosted runner pool serves every repo', guide: 'Isolating one job affects others.' },
      { id: 'signing_central', label: 'One signing key is used for all artefacts', guide: 'Rotating it invalidates everything signed with it.' },
      { id: 'audit_required', label: 'A customer audit requires provenance for shipped artefacts', guide: 'Preserve build records while responding.' },
      { id: 'small_platform_team', label: 'A two-person platform team owns CI for the company', guide: 'Prefer durable, low-maintenance controls.' },
    ],
    components: [
      'source repository', 'pull request', 'CI workflow', 'hosted runner', 'self-hosted runner', 'build secrets', 'OIDC federation', 'cloud deploy role', 'artefact registry', 'container registry', 'image tag', 'image digest', 'dependency manifest', 'dependency proxy', 'package registry', 'upstream public registry', 'signing key', 'provenance attestation', 'SCA scanner', 'approval gate', 'admission controller', 'IaC module', 'remote state backend', 'apply role', 'GitOps reconciler', 'config repository', 'secrets operator', 'webhook', 'build log', 'registry audit log', 'cloud audit log', 'crash-reporting SDK', 'chat integration',
    ],
  },
  guidance: `DevSecOps & Supply Chain realism rules:
- Use concrete names (for example "workflow deploy.yml", "runner pool shared-01", "deploy-prod OIDC role", "registry tag :latest", "module terraform-aws-vpc"). Never invent product features that do not exist; describe a dependency bug without a CVE id if one is needed.
- The attack path must be technically valid stage by stage: each step uses a trust, a credential, a mutable reference, a reused runner, a resolver preference or an unverified artefact the diagram shows. If a control on the diagram (signature verification, digest pinning, fork-PR restrictions, approval gate, admission policy) would block a step, the path must go around it or the narrative must say why it did not apply.
- Be exact about what each control proves: a signature proves who built it, not that the inputs were clean; an SCA scan sees known-vulnerable versions, not malicious behaviour; an approval gate checks a human clicked, not the artefact.
- Trust boundaries are real boundaries: developer, source control, build/CI, artefact storage, deployment identity, runtime/cluster, third-party registry or SDK.
- The best answer must be the one an experienced DevSecOps engineer would choose for this exact pipeline and constraint; distractors must be sound practices that address a different stage, do not break this path, or violate the constraint.
- Cite techniques from the ATT&CK Enterprise matrix only, favouring Initial Access (supply chain), Execution, Persistence and Credential Access.`,
};
