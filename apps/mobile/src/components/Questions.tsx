import { type ChoiceQuestion, type OrderQuestion, type Question, isCorrectOrder, shuffleForDisplay } from "@breinhap/content";
import { useMemo } from "react";
import { View } from "react-native";
import type { Answer } from "../progress/model";
import { useSettings } from "../settings/SettingsContext";
import { spacing } from "../theme/tokens";
import { AppText, Button, Card, styles } from "./ui";

interface Props<Q> {
  question: Q;
  /** Called once the student has seen the feedback and wants to go on. */
  onDone: () => void;
  answer?: Answer;
  onAnswer: (answer: Answer) => void;
  disabled?: boolean;
}

export function QuestionView({ question, seed, ...props }: Props<Question> & { seed: number }) {
  return question.kind === "choice" ? (
    <ChoiceView question={question} {...props} />
  ) : (
    <OrderView question={question} {...props} seed={seed} />
  );
}

/**
 * Feedback says "Klopt" or "Nog niet" and always explains why.
 * No time pressure, no lost lives.
 */
function Feedback({
  correct,
  explanation,
  onNext,
  disabled,
}: { correct: boolean; explanation: string; onNext: () => void; disabled?: boolean }) {
  const { palette } = useSettings();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        backgroundColor: correct ? palette.feedbackRight : palette.feedbackNotYet,
        borderRadius: 12,
        padding: spacing.md,
        gap: spacing.sm,
      }}
    >
      <AppText variant="title">{correct ? "Klopt." : "Nog niet."}</AppText>
      <AppText>{explanation}</AppText>
      <Button label="Verder" onPress={onNext} disabled={disabled} />
    </View>
  );
}

function ChoiceView({ question, onDone, answer, onAnswer, disabled }: Props<ChoiceQuestion>) {
  const chosen = answer?.kind === "choice" ? answer.chosen : null;
  const answered = chosen !== null;
  return (
    <Card>
      <AppText variant="title">{question.prompt}</AppText>
      {question.options.map((option, i) => (
        <Button
          key={option}
          kind={chosen === i ? "primary" : "secondary"}
          label={option}
          disabled={disabled || (answered && chosen !== i)}
          onPress={() => onAnswer({ kind: "choice", chosen: i })}
        />
      ))}
      {answered && (
        <Feedback correct={chosen === question.answerIndex} explanation={question.explanation} onNext={onDone} disabled={disabled} />
      )}
    </Card>
  );
}

/**
 * Put items in order by tapping them one by one. Tapping is the accessible
 * default (works with TalkBack and switch access); drag can come later.
 */
function OrderView({ question, onDone, seed, answer, onAnswer, disabled }: Props<OrderQuestion> & { seed: number }) {
  const shown = useMemo(() => shuffleForDisplay(question.items, seed), [question.items, seed]);
  const placed = answer?.kind === "order" ? answer.placed : [];
  const checked = answer?.kind === "order" ? answer.checked : false;
  const setPlaced = (next: string[]) => onAnswer({ kind: "order", placed: next, checked: false });
  const remaining = shown.filter((item) => !placed.includes(item));
  const correct = isCorrectOrder(question.items, placed);

  return (
    <Card>
      <AppText variant="title">{question.prompt}</AppText>
      <AppText muted>Tik de stukjes aan in de juiste volgorde. Tik een gekozen stukje om het terug te zetten.</AppText>

      <View style={{ gap: spacing.sm }}>
        {placed.map((item, i) =>
          // After checking, show the answer as plain text: a faded button is hard to read.
          checked ? (
            <AppText key={item}>{`${i + 1}. ${item}`}</AppText>
          ) : (
            <Button
              key={item}
              label={`${i + 1}. ${item}`}
              accessibilityHint="Zet dit stukje terug"
              disabled={disabled}
              onPress={() => setPlaced(placed.filter((p) => p !== item))}
            />
          ),
        )}
      </View>

      {remaining.length > 0 && (
        <View style={styles.row}>
          {remaining.map((item) => (
            <Button key={item} kind="secondary" label={item} onPress={() => setPlaced([...placed, item])} disabled={disabled} />
          ))}
        </View>
      )}

      {!checked && remaining.length === 0 && (
        <Button label="Controleer" disabled={disabled} onPress={() => onAnswer({ kind: "order", placed, checked: true })} />
      )}

      {checked && (
        <Feedback
          correct={correct}
          explanation={correct ? question.explanation : `De juiste volgorde: ${question.items.join(" → ")}. ${question.explanation}`}
          onNext={onDone}
          disabled={disabled}
        />
      )}
    </Card>
  );
}
