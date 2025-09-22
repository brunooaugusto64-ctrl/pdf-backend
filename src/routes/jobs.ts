import { Router } from 'express'

console.log('[jobs.ts] carregando router…')

const router = Router()

router.get('/jobs', (_req, res) => {
  console.log('[jobs.ts] GET /jobs chamado')
  res.json([
    { id: 1, file: 'teste.pdf', status: 'done' },
    { id: 2, file: 'exemplo.pdf', status: 'processing' },
  ])
})

export default router
