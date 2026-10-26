// Generated from immutable Agent capacity release. Do not edit.
export const agentCapacityGuarantee = {
  artifact_version: "1.0.0",
  owner: "kokoro-agent",
  guarantee_id: "openai-gpt4o-20240806-text-standard-v1",
  profile_id: "openai_chat_completions_capacity_v1",
  trust_class: "provider-documented/Agent-enforced",
  protocol: "openai_chat_completions",
  connection_type: "direct",
  endpoint: "https://api.openai.com/v1/chat/completions",
  request_model: "gpt-4o-2024-08-06",
  context_window: 128000,
  max_output_tokens: 16384,
  unit: "token",
  n: 1,
  stream: false,
  service_tier: "default",
  store: false,
  roles: ["system", "user", "assistant"],
  request_fields: [
    "model",
    "messages",
    "n",
    "max_completion_tokens",
    "stream",
    "service_tier",
    "store",
  ],
  joint_constraints: [
    "0<=P<=128000",
    "0<=O<=M<=16384",
    "total=P+O",
    "K+U=P",
    "R+V=O",
  ],
  unsupported_policy: "fail_closed_before_prepare",
  uncertain_result_policy: "unknown_no_retry_no_automatic_release",
  sunset: "2027-01-14T00:00:00Z",
  evidence_checked_on: "2026-10-23",
  enforcement_revision: "agent-final-wire-text-v1",
  usage_semantics:
    "cached_input_subset_of_prompt;reasoning_subset_of_completion;no_extra_cache_write_fee_for_fixed_4o;unknown_categories_unsupported",
  normalization_owner: "kokoro-agent",
  normalization_version: "1.0.0",
  normalization_manifest_aggregate_sha256:
    "ecd30d1908f410eed29181c9f52669f824312bf3a2e3874153d990b95fe58b91",
  evidence_version: "1.0.0",
  evidence_sha256:
    "e8ddcfc7e711d95c5324d319bfe254f7e15008708546616199748c7739d0201f",
} as const;
export const agentCapacityManifest = {
  owner: "kokoro-agent",
  artifact_version: "1.0.0",
  guarantee_sha256:
    "326f7d12d6cdfecf46f78f66ff7400378dc76ee4386146687a8574cf03af6995",
  evidence_sha256:
    "e8ddcfc7e711d95c5324d319bfe254f7e15008708546616199748c7739d0201f",
  source_sha256: {
    "contract/model-call-capacity-guarantee/v1/schema.json":
      "c00852c059920e10f498e01e641f2270a896cc8392f79ff97261167da8c922c8",
    "contract/model-call-capacity-guarantee/v1/guarantee.json":
      "7c3da26f60d42addd029876c31ad4a1b7c3ce3090187975e03ded73327041ece",
    "contract/model-call-capacity-guarantee/v1/evidence.json":
      "07f5f501b81b78ded69e0127996bc975dcb6b6bdb1d17a97e105bd4ad2dd187a",
    "contract/model-call-capacity-guarantee/v1/vectors.json":
      "332b4cd0444299ad4a5ee125a9a06c42b03c6e06d25667cb89f26d16d248e689",
    "contract/usage/v1/manifest.json":
      "29d15de901e60b1026ff3834249a4f5c442092b7ccef1981baaabcfaf30cbea1",
    "scripts/generate_model_call_capacity_guarantee.py":
      "0401c88216e32af18118b34cc923b732cdcc47384385d8a77a40a7c7144f6421",
    "src/kokoro_agent/model_call_capacity_guarantee_contract.py":
      "6810f9ad89bead074d5f07d55037463c47188348f7b70404c8da598d6adc95cf",
    "src/kokoro_agent/model/capacity_guarantee.py":
      "be4963c62eb11f91a7f4bc231579f9ce29e73442caff85fd61374830c9473d8b",
    "src/kokoro_agent/model/factory.py":
      "3169b4b3df212c36dfa47f12fb96b8ff1672e73456b7b027bfbf801159ed506c",
    "src/kokoro_agent/distribution_assets.py":
      "0b4e3cca741544eecaeddafb396acc2e6b6b6ab9b74bd48e5ec4242ffe6f1217",
    "src/kokoro_agent/protocol/model_call_capacity_guarantee_generated.py":
      "d2aeace75c10c75c548e06a3288c370d4bc8c3a9aad0e176c5022008ca733857",
  },
  aggregate_sha256:
    "807bed09daefd7b3151e69b1d489ae6113c63231a8099ede65f19fb166490798",
} as const;
export const SOURCE_DIGESTS = {
  version: "1.0.0",
  schema_path: "contract/model-call-capacity-guarantee/v1/schema.json",
  schema_sha256:
    "c00852c059920e10f498e01e641f2270a896cc8392f79ff97261167da8c922c8",
  guarantee_path: "contract/model-call-capacity-guarantee/v1/guarantee.json",
  guarantee_sha256:
    "7c3da26f60d42addd029876c31ad4a1b7c3ce3090187975e03ded73327041ece",
  evidence_path: "contract/model-call-capacity-guarantee/v1/evidence.json",
  evidence_sha256:
    "07f5f501b81b78ded69e0127996bc975dcb6b6bdb1d17a97e105bd4ad2dd187a",
  vectors_path: "contract/model-call-capacity-guarantee/v1/vectors.json",
  vectors_sha256:
    "332b4cd0444299ad4a5ee125a9a06c42b03c6e06d25667cb89f26d16d248e689",
  manifest_path: "contract/model-call-capacity-guarantee/v1/manifest.json",
  manifest_sha256:
    "59daa7c2838c91ec92a3688befb3710f710abffa9f358802cbdfdd7f5f8e0c59",
} as const;
