'use client';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { examSeries, type ExamDefinition, type ExamResult } from '@/lib/exams';

const dateLabel = (date: string) => date.split('-').reverse().join('/');

export type ExamChartProps = {
  results: ExamResult[];
  definition: ExamDefinition;
  graph: string;
};

export function ExamChart({ results, definition, graph }: ExamChartProps) {
  const matchingResults = results.filter(
    (r) => r.definition_id === definition.id,
  );
  const targetUnit = definition.fields.find((f) => f.id === graph)?.unit;
  const seriesList = examSeries(matchingResults, graph, targetUnit);

  if (!seriesList.length) {
    return <p>Nenhum valor numérico exato disponível para o gráfico.</p>;
  }

  return (
    <>
      {seriesList.map((series) => {
        const chartData = series.points.map((p, index, array) => {
          const sameDateIndex = array
            .slice(0, index)
            .filter((item) => item.date === p.date).length;
          const baseTime = new Date(`${p.date}T12:00:00Z`).getTime();
          return {
            ...p,
            time: baseTime + sameDateIndex * 3600000,
          };
        });

        return (
          <div key={series.key}>
            <p>{series.label}</p>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart
                data={chartData}
                margin={{ top: 10, right: 25, bottom: 10, left: 15 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={
                    series.points.length === 1
                      ? [
                          (dataMin: number) => dataMin - 86400000,
                          (dataMax: number) => dataMax + 86400000,
                        ]
                      : ['dataMin', 'dataMax']
                  }
                  ticks={
                    series.points.length === 1 && chartData.length === 1
                      ? [chartData[0].time]
                      : undefined
                  }
                  tickFormatter={(v) =>
                    dateLabel(new Date(v).toISOString().slice(0, 10))
                  }
                />
                <YAxis domain={['auto', 'auto']} />
                <Tooltip
                  labelFormatter={(v) =>
                    dateLabel(new Date(Number(v)).toISOString().slice(0, 10))
                  }
                  formatter={(value, _name, item) => {
                    const p = (
                      item as {
                        payload?: {
                          unit?: string;
                          laboratory?: string;
                          method?: string;
                          specimen?: string;
                          reference?: string;
                        };
                      }
                    )?.payload;
                    const parts = [
                      p?.unit,
                      p?.laboratory ? `Lab: ${p.laboratory}` : null,
                      p?.method ? `Método: ${p.method}` : null,
                      p?.specimen ? `Material: ${p.specimen}` : null,
                      p?.reference ? `Ref: ${p.reference}` : null,
                    ].filter(Boolean);
                    const suffix = parts.length ? ` (${parts.join(' · ')})` : '';
                    return [`${value}${suffix}`, 'Resultado'];
                  }}
                />
                <Line
                  name="Resultado"
                  type="linear"
                  dataKey="value"
                  stroke="var(--exam-accent, #537d98)"
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        );
      })}
    </>
  );
}

export default ExamChart;
