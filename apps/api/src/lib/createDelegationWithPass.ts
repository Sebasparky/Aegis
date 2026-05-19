import { randomUUID } from "crypto";
import type { AgentDelegation, AgentDelegationChannel, SkillAccessMode } from "@aegis/types";
import { agentDelegations, passes, users, MOCK_USER_ID, newId } from "../store/index.js";
import type { PassWithToken } from "../store/index.js";
import { schedulePersist } from "../store/persistence.js";

export interface CreateDelegationParams {
  agent_name: string;
  agent_platform?: string;
  channel?: AgentDelegationChannel;
  default_collar_id?: string;
  expires_in_minutes?: number;
  skill_access_mode?: SkillAccessMode;
  skill_access_skill_ids?: string[];
}

export interface CreateDelegationResult {
  delegation: AgentDelegation;
  pass: PassWithToken;
  token: string;
}

export function createDelegationWithPass(params: CreateDelegationParams): CreateDelegationResult {
  const {
    agent_name,
    agent_platform,
    channel = "api",
    default_collar_id,
    expires_in_minutes = 525600,
    skill_access_mode,
    skill_access_skill_ids,
  } = params;

  const user = users.get(MOCK_USER_ID);
  const user_aegis_id = user?.aegis_id ?? "aid_user_001";

  const now = new Date().toISOString();
  const expires_at = new Date(Date.now() + expires_in_minutes * 60 * 1000).toISOString();

  const token = `aegis_pass_${randomUUID().replace(/-/g, "")}`;
  const pass: PassWithToken = {
    id: newId("pass"),
    token,
    user_id: MOCK_USER_ID,
    agent_name,
    purpose: `Delegation for ${agent_name}`,
    ...(default_collar_id ? { default_collar_id } : {}),
    status: "active",
    expires_at,
    created_at: now,
  };
  passes.set(pass.id, pass);

  const delegation: AgentDelegation = {
    id: newId("delg"),
    user_id: MOCK_USER_ID,
    user_aegis_id,
    agent_name,
    ...(agent_platform ? { agent_platform } : {}),
    channel,
    ...(default_collar_id ? { default_collar_id } : {}),
    status: "active",
    token_id: pass.id,
    created_at: now,
    updated_at: now,
    expires_at,
    ...(skill_access_mode ? { skill_access_mode } : {}),
    ...(skill_access_skill_ids ? { skill_access_skill_ids } : {}),
  };
  agentDelegations.set(delegation.id, delegation);
  schedulePersist();

  return { delegation, pass, token };
}
