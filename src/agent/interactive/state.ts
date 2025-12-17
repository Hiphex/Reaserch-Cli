export interface ResearchResult {
    text: string;
    sources: string[];
    reasoning?: string[];
}

export interface ConversationTurn {
    query: string;
    result: ResearchResult;
}

export interface AgentState {
    question: string;
    status: string;
    sources: number;
    complete: boolean;
    failed: boolean;
}
