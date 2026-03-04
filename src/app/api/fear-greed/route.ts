import { NextResponse } from 'next/server'

export const revalidate = 3600 // atualiza 1x por hora (o índice muda diariamente)

export async function GET() {
  try {
    // Busca os últimos 30 dias para ter: hoje, ontem, semana passada e mês passado
    const res = await fetch(
      'https://api.alternative.me/fng/?limit=30&format=json',
      { next: { revalidate: 3600 } }
    )

    if (!res.ok) throw new Error('Alternative.me error')

    const json = await res.json()
    const data = json.data

    if (!data || data.length === 0) throw new Error('empty data')

    // data[0] = hoje, data[1] = ontem, data[6] = ~semana, data[29] = ~mês
    const now      = data[0]
    const yesterday = data[1] ?? data[0]
    const weekAgo  = data[6] ?? data[0]
    const monthAgo = data[29] ?? data[0]

    return NextResponse.json({
      now: {
        value: parseInt(now.value),
        label: now.value_classification,
      },
      yesterday: {
        value: parseInt(yesterday.value),
        label: yesterday.value_classification,
      },
      weekAgo: {
        value: parseInt(weekAgo.value),
        label: weekAgo.value_classification,
      },
      monthAgo: {
        value: parseInt(monthAgo.value),
        label: monthAgo.value_classification,
      },
    })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 })
  }
}
