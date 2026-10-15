// HTTP routes for Newbie Demo Mode (/api/demo) and the homepage
// walkthrough preview (/api/tour). Additive: no existing route changes.

import express from 'express';
import {
  demoInfo, demoCase, startDemo, resetDemoById, demoState, checkBeat, gotoBeat, skipBeat, setStatus, summaryOf,
} from './service.js';
import { previewFor } from './autoplay.js';

const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export const demoRouter = express.Router();

demoRouter.get('/info', (req, res) => res.json(demoInfo()));

demoRouter.post('/start', wrap((req, res) => {
  const b = req.body || {};
  const c = startDemo({ analyst: b.analyst, resumeId: b.resumeId, nonce: b.nonce, user: req.user });
  res.status(201).json({ id: c.id, ticket: c.ticket, status: c.demo.status });
}));

demoRouter.get('/:id', wrap((req, res) => res.json(demoState(demoCase(req.params.id, req.user)))));

demoRouter.post('/:id/check', wrap((req, res) => {
  const b = req.body || {};
  res.json(checkBeat(demoCase(req.params.id, req.user), b.beat, b.data, !!b.quiet));
}));

demoRouter.post('/:id/goto', wrap((req, res) => res.json({ progress: gotoBeat(demoCase(req.params.id, req.user), (req.body || {}).beat) })));
demoRouter.post('/:id/skip', wrap((req, res) => res.json({ progress: skipBeat(demoCase(req.params.id, req.user), (req.body || {}).beat) })));
demoRouter.post('/:id/status', wrap((req, res) => res.json({ progress: setStatus(demoCase(req.params.id, req.user), (req.body || {}).status) })));

demoRouter.post('/:id/reset', wrap((req, res) => {
  const c = resetDemoById(req.params.id, (req.body || {}).nonce, req.user);
  res.status(201).json({ id: c.id, ticket: c.ticket, status: c.demo.status });
}));

demoRouter.get('/:id/summary', wrap((req, res) => res.json(summaryOf(demoCase(req.params.id, req.user)))));

export const tourRouter = express.Router();

// Returns a read-only sample ticket for the walkthrough to point at.
tourRouter.post('/preview', wrap((req, res) => res.json(previewFor(String((req.body || {}).point || 'l1')))));
