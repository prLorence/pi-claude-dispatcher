export namespace model {
	
	export class ReviewResult {
	    verdict: string;
	    findings?: number;
	    failed: boolean;
	    text?: string;
	
	    static createFrom(source: any = {}) {
	        return new ReviewResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.verdict = source["verdict"];
	        this.findings = source["findings"];
	        this.failed = source["failed"];
	        this.text = source["text"];
	    }
	}
	export class Attempt {
	    id: string;
	    label: string;
	    state: string;
	    model?: string;
	    thinking?: string;
	    startedAt?: string;
	    elapsedS?: number;
	    tokens?: number;
	    cost?: number;
	    lastTool?: string;
	    error?: string;
	    hasSession: boolean;
	    review?: ReviewResult;
	
	    static createFrom(source: any = {}) {
	        return new Attempt(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.state = source["state"];
	        this.model = source["model"];
	        this.thinking = source["thinking"];
	        this.startedAt = source["startedAt"];
	        this.elapsedS = source["elapsedS"];
	        this.tokens = source["tokens"];
	        this.cost = source["cost"];
	        this.lastTool = source["lastTool"];
	        this.error = source["error"];
	        this.hasSession = source["hasSession"];
	        this.review = this.convertValues(source["review"], ReviewResult);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DeciderFinding {
	    id: string;
	    severity: string;
	    p: number;
	
	    static createFrom(source: any = {}) {
	        return new DeciderFinding(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.severity = source["severity"];
	        this.p = source["p"];
	    }
	}
	export class DeciderAuditView {
	    proposal: string;
	    aggregate: number;
	    verdict: string;
	    auditRound: number;
	    findings: DeciderFinding[];
	
	    static createFrom(source: any = {}) {
	        return new DeciderAuditView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.proposal = source["proposal"];
	        this.aggregate = source["aggregate"];
	        this.verdict = source["verdict"];
	        this.auditRound = source["auditRound"];
	        this.findings = this.convertValues(source["findings"], DeciderFinding);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class DeciderTaskView {
	    suggested: string;
	    probabilities: Record<string, number>;
	    confidence?: number;
	    complexity?: number;
	    ran?: string;
	
	    static createFrom(source: any = {}) {
	        return new DeciderTaskView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.suggested = source["suggested"];
	        this.probabilities = source["probabilities"];
	        this.confidence = source["confidence"];
	        this.complexity = source["complexity"];
	        this.ran = source["ran"];
	    }
	}
	export class EntryTool {
	    name: string;
	    args: string;
	
	    static createFrom(source: any = {}) {
	        return new EntryTool(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.args = source["args"];
	    }
	}
	export class Entry {
	    line: number;
	    ts?: string;
	    kind: string;
	    text: string;
	    collapsed: boolean;
	    truncated: boolean;
	    tool?: EntryTool;
	    isError: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Entry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.line = source["line"];
	        this.ts = source["ts"];
	        this.kind = source["kind"];
	        this.text = source["text"];
	        this.collapsed = source["collapsed"];
	        this.truncated = source["truncated"];
	        this.tool = this.convertValues(source["tool"], EntryTool);
	        this.isError = source["isError"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Lane {
	    state: string;
	    attempts: Attempt[];
	
	    static createFrom(source: any = {}) {
	        return new Lane(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.state = source["state"];
	        this.attempts = this.convertValues(source["attempts"], Attempt);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TaskRow {
	    id: string;
	    role: string;
	    pair?: string;
	    dependsOn: string[];
	    waitsFor: string[];
	    skipped: boolean;
	    implementer: Lane;
	    reviewer?: Lane;
	    decider?: DeciderTaskView;
	
	    static createFrom(source: any = {}) {
	        return new TaskRow(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.role = source["role"];
	        this.pair = source["pair"];
	        this.dependsOn = source["dependsOn"];
	        this.waitsFor = source["waitsFor"];
	        this.skipped = source["skipped"];
	        this.implementer = this.convertValues(source["implementer"], Lane);
	        this.reviewer = this.convertValues(source["reviewer"], Lane);
	        this.decider = this.convertValues(source["decider"], DeciderTaskView);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PlanView {
	    id: string;
	    trace: string;
	    round: number;
	    state: string;
	    gate?: string;
	    done: number;
	    total: number;
	    tasks: TaskRow[];
	    audit?: DeciderAuditView;
	
	    static createFrom(source: any = {}) {
	        return new PlanView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.trace = source["trace"];
	        this.round = source["round"];
	        this.state = source["state"];
	        this.gate = source["gate"];
	        this.done = source["done"];
	        this.total = source["total"];
	        this.tasks = this.convertValues(source["tasks"], TaskRow);
	        this.audit = this.convertValues(source["audit"], DeciderAuditView);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RepoView {
	    name: string;
	    active: boolean;
	    plan?: PlanView;
	    message?: string;
	    startedAt?: string;
	    lastActivity?: string;
	
	    static createFrom(source: any = {}) {
	        return new RepoView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.active = source["active"];
	        this.plan = this.convertValues(source["plan"], PlanView);
	        this.message = source["message"];
	        this.startedAt = source["startedAt"];
	        this.lastActivity = source["lastActivity"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class MonitorState {
	    repos: RepoView[];
	    message?: string;
	    now: string;
	
	    static createFrom(source: any = {}) {
	        return new MonitorState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.repos = this.convertValues(source["repos"], RepoView);
	        this.message = source["message"];
	        this.now = source["now"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	export class SessionPage {
	    id: string;
	    live: boolean;
	    ended: boolean;
	    entries: Entry[];
	    next: number;
	
	    static createFrom(source: any = {}) {
	        return new SessionPage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.live = source["live"];
	        this.ended = source["ended"];
	        this.entries = this.convertValues(source["entries"], Entry);
	        this.next = source["next"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

