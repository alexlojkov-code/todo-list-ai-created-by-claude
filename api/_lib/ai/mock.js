// Локальный провайдер для разработки: без сети, приоритет по сроку и ключевым словам.

const URGENT_WORDS = ['срочно', 'важно', 'дедлайн', 'оплат', 'налог', 'врач', 'отчёт', 'отчет'];
const DAY = 24 * 60 * 60 * 1000;

function daysLeft(dueDate, today) {
  if (!dueDate) return null;
  return Math.round((Date.parse(dueDate) - Date.parse(today)) / DAY);
}

export function createMockProvider() {
  return {
    name: 'mock',
    enabled: true,
    model: 'эвристика',
    async prioritize(tasks, { today }) {
      return tasks.map(task => {
        const text = `${task.title} ${task.description || ''}`.toLowerCase();
        const urgentWord = URGENT_WORDS.find(w => text.includes(w));
        const days = daysLeft(task.dueDate, today);

        let score = 40;
        const reasons = [];
        if (days !== null) {
          if (days < 0) { score += 50; reasons.push('срок прошёл'); }
          else if (days <= 1) { score += 40; reasons.push(days === 0 ? 'срок сегодня' : 'срок завтра'); }
          else if (days <= 7) { score += 20; reasons.push('срок на этой неделе'); }
          else { score -= 10; reasons.push('срок не скоро'); }
        } else {
          score -= 5;
          reasons.push('без срока');
        }
        if (urgentWord) { score += 15; reasons.push(`в тексте «${urgentWord}…»`); }
        score = Math.max(0, Math.min(100, score));

        const priority = score >= 85 ? 'critical' : score >= 65 ? 'high' : score >= 40 ? 'medium' : 'low';
        const reason = reasons.join(', ');
        return { id: task.id, priority, score, reason: reason[0].toUpperCase() + reason.slice(1) };
      });
    },
  };
}
