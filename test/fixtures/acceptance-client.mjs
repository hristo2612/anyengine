import readline from 'node:readline'

let pending
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'thread/start') {
    pending = message
    send({
      method: 'thread/started',
      params: { thread: { id: 'unrelated', cwd: message.params.cwd } },
    })
    if (process.env.FAKE_ORDER !== 'withheld')
      send({
        id: message.id,
        result: {
          thread: { id: 'owned', cwd: message.params.cwd, ephemeral: false },
          model: message.params.model,
        },
      })
  } else if (message.method === 'fixture/reply') {
    send({
      id: pending.id,
      result: {
        thread: {
          id: message.params.conflict ? 'conflicting' : 'owned',
          cwd: pending.params.cwd,
          ephemeral: false,
        },
        model: message.params.wrongModel ? 'wrong' : pending.params.model,
      },
    })
    send({ id: message.id, result: {} })
  } else if (message.method === 'turn/start') {
    send({
      method: 'item/completed',
      params: {
        threadId: message.params.threadId,
        turnId: 'fast',
        item: { type: 'agentMessage', text: message.params.model ?? 'default' },
      },
    })
    send({
      method: 'turn/completed',
      params: {
        threadId: message.params.threadId,
        turn: { id: 'fast', status: 'completed', error: null },
      },
    })
    send({ id: message.id, result: { turn: { id: 'fast' } } })
  } else if (message.method === 'thread/unsubscribe')
    send({ id: message.id, result: { status: 'unsubscribed' } })
  else if (message.method === 'thread/delete') {
    send({ method: 'thread/deleted', params: { threadId: message.params.threadId } })
    send({ id: message.id, result: {} })
  } else send({ id: message.id, result: {} })
})
