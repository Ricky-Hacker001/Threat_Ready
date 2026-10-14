import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type {
  ClarifyRequest,
  CreateInterviewRequest,
  CreateTextDocumentRequest,
  CreateUploadRequest,
  PlanInterviewRequest,
  SubmitAnswerRequest,
  UpdateDocumentTextRequest,
} from '@threatready/contracts';
import { TERMINAL_STATES } from '@threatready/contracts';
import type { Response } from 'express';
import type { AuthedRequest } from '../platform/http/route.guard.js';
import { Public, Route } from '../platform/http/route.decorator.js';
import { SseStream } from '../platform/http/sse.js';
import { AssetsService } from './assets/assets.service.js';
import { DocumentsService } from './documents/documents.service.js';
import { InterviewService } from './interview/interview.service.js';
import { TurnService } from './interview/turn.service.js';
import { ReportsService } from './reports/reports.service.js';
import { SkillsService } from './skills/skills.service.js';

@Controller('v1/documents')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly docs: DocumentsService) {}

  @Post()
  @HttpCode(201)
  @Route('createUpload')
  create(@Req() req: AuthedRequest, @Body() body: CreateUploadRequest) {
    return this.docs.createUpload(req.principal, body);
  }

  @Post('text')
  @HttpCode(201)
  @Route('createTextDocument')
  createText(@Req() req: AuthedRequest, @Body() body: CreateTextDocumentRequest) {
    return this.docs.createText(req.principal, body);
  }

  @Post(':id/complete')
  @HttpCode(202)
  @Route('completeUpload')
  complete(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.docs.completeUpload(req.principal, id);
  }

  @Get(':id')
  @Route('getDocument')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.docs.get(req.principal, id);
  }

  @Patch(':id/text')
  @Route('updateDocumentText')
  updateText(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: UpdateDocumentTextRequest) {
    return this.docs.updateText(req.principal, id, body.text);
  }

  @Delete(':id')
  @HttpCode(204)
  @Route('deleteDocument')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.docs.delete(req.principal, id);
  }
}

@Controller('v1/interviews')
export class InterviewsController {
  constructor(
    @Inject(InterviewService) private readonly interviews: InterviewService,
    @Inject(TurnService) private readonly turns: TurnService,
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  @Post()
  @HttpCode(202)
  @Route('createInterview')
  create(@Req() req: AuthedRequest, @Body() body: CreateInterviewRequest) {
    return this.interviews.create(req.principal, body);
  }

  @Get()
  @Route('listInterviews')
  list(@Req() req: AuthedRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const n = Math.min(50, Math.max(1, Number(limit) || 20));
    return this.interviews.list(req.principal, cursor, n);
  }

  @Get(':id')
  @Route('getInterview')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.interviews.get(req.principal, id);
  }

  /** SSE: pushes state changes while analysis or report jobs run; ends at a stable state. */
  @Get(':id/events')
  @Route('streamInterviewEvents')
  async events(@Req() req: AuthedRequest, @Param('id') id: string, @Res() res: Response) {
    const first = await this.interviews.stateOf(req.principal, id);
    const sse = new SseStream(res);
    sse.open();
    let last = '';
    const deadline = Date.now() + 5 * 60_000;
    const stable = new Set<string>([...TERMINAL_STATES, 'profiled', 'planned', 'awaiting_answer', 'paused']);
    let state = first;
    while (!sse.isClosed && Date.now() < deadline) {
      const sig = `${state.state}:${state.version}`;
      if (sig !== last) {
        last = sig;
        sse.send({ type: 'state', state: state.state, version: state.version });
        if (stable.has(state.state)) break;
      }
      await new Promise((r) => setTimeout(r, 2000));
      state = await this.interviews.stateOf(req.principal, id).catch(() => state);
    }
    sse.end();
  }

  @Get(':id/briefing')
  @Route('getBriefing')
  briefing(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.interviews.briefing(req.principal, id);
  }

  @Post(':id/plan')
  @HttpCode(200)
  @Route('planInterview')
  plan(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: PlanInterviewRequest) {
    return this.interviews.plan(req.principal, id, body);
  }

  @Post(':id/start')
  @Route('startInterview')
  start(@Req() req: AuthedRequest, @Param('id') id: string, @Res() res: Response) {
    return stream(res, (sse) => this.turns.start(req.principal, id, sse));
  }

  @Post(':id/question')
  @Route('askQuestion')
  ask(@Req() req: AuthedRequest, @Param('id') id: string, @Res() res: Response) {
    return stream(res, (sse) => this.turns.ask(req.principal, id, sse));
  }

  @Post(':id/turns')
  @Route('submitAnswer')
  submit(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: SubmitAnswerRequest, @Res() res: Response) {
    return stream(res, (sse) => this.turns.submit(req.principal, id, body, sse));
  }

  @Post(':id/clarify')
  @Route('clarifyQuestion')
  clarify(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: ClarifyRequest, @Res() res: Response) {
    return stream(res, (sse) => this.turns.clarify(req.principal, id, body, sse));
  }

  @Post(':id/pause')
  @HttpCode(200)
  @Route('pauseInterview')
  pause(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.interviews.pause(req.principal, id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @Route('resumeInterview')
  resume(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.interviews.resume(req.principal, id);
  }

  @Post(':id/end')
  @HttpCode(200)
  @Route('endInterview')
  end(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.interviews.end(req.principal, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Route('cancelInterview')
  cancel(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.interviews.cancel(req.principal, id);
  }

  @Get(':id/report')
  @Route('getReport')
  report(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.reports.getReport(req.principal, id);
  }

  @Post(':id/report/retry')
  @HttpCode(202)
  @Route('retryReport')
  retry(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.interviews.retryReport(req.principal, id);
  }

  @Get(':id/report/pdf')
  @Route('getReportPdf')
  pdf(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.reports.getPdfUrl(req.principal, id);
  }
}

@Controller('v1')
export class ProgressController {
  constructor(@Inject(SkillsService) private readonly skills: SkillsService) {}

  @Get('interview-prep/dashboard')
  @Route('getDashboard')
  dashboard(@Req() req: AuthedRequest) {
    return this.skills.dashboard(req.principal);
  }

  @Get('skills/me')
  @Route('getMySkills')
  mine(@Req() req: AuthedRequest) {
    return this.skills.mySkills(req.principal);
  }
}

@Controller('v1')
export class MeController {
  /** The signed-in user. Identity comes from onboard.threatready.io; there is no local sign-in. */
  @Get('me')
  @Route('getMe')
  me(@Req() req: AuthedRequest) {
    const p = req.principal;
    return { id: p.userId, name: p.name, email: p.email, image: p.image ?? null, isAdmin: p.isStaff };
  }
}

@Controller('v1/assets')
export class AssetsController {
  constructor(@Inject(AssetsService) private readonly assets: AssetsService) {}

  @Get('interviewer-model')
  @Route('getInterviewerModel')
  async interviewerModel(@Res() res: Response) {
    const a = await this.assets.interviewerModel();
    res.set({
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'private, no-store',
      'X-Asset-Key': a.key,
      'X-Asset-Iv': a.iv,
      'X-Content-Type-Options': 'nosniff',
    });
    res.status(200).end(a.body);
  }
}

@Controller()
export class HealthController {
  @Get('healthz')
  @Public()
  health() {
    return { ok: true };
  }
}

/**
 * Runs a streaming handler. Errors before the first byte become a normal envelope via the filter;
 * errors after it are reported in-band as an `error` event.
 */
async function stream(res: Response, run: (sse: SseStream) => Promise<void>): Promise<void> {
  const sse = new SseStream(res);
  try {
    await run(sse);
  } catch (err) {
    if (!sse.started) throw err; // nothing sent yet: the exception filter returns the envelope
    sse.error(err);
  }
  sse.end();
}
