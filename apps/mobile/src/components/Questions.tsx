import { isCorrectOrder, shuffleForDisplay, type ChoiceQuestion, type OrderQuestion, type Question } from "@breinhap/content";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useSettings } from "../settings/SettingsContext";
import { spacing } from "../theme/tokens";
import { AppText, Button, Card, styles } from "./ui";

interface Props<Q> {
  question: Q;
  /** Called once the student has seen the feedback and wants to go on. */
  onDone: (correct: boolean) => void;
}

export function QuestionView({ question, onDone, seed }: Props<Question> & { seed: number }) {
  return question.kind === "choice" ? (
    <ChoiceView question={question} onDone={onDone} />
  ) : (
    <OrderView question={question} onDone={onDone} seed={seed} />
  );
}

/**
 * Feedback says "Klopt" or "Nog niet" and always explains why.
 * No time pressure, no lost lives.
 */
function Feedback({ correct, explanation, onNext }: { correct: boolean; explanation: string; onNext: () => void }) {
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
      <Button label="Verder" onPress={onNext} />
    </View>
  );
}

function ChoiceView({ question, onDone }: Props<ChoiceQuestion>) {
  const [chosen, setChosen] = useState<number | null>(null);
  const answered = chosen !== null;
  return (
    <Card>
      <AppText variant="title">{question.prompt}</AppText>
      {question.options.map((option, i) => (
        <Button
          key={option}
          kind={chosen === i ? "primary" : "secondary"}
          label={option}
          disabled={answered && chosen !== i}
          onPress={() => setChosen(i)}
        />
      ))}
      {answered && (
        <Feedback
          correct={chosen === question.answerIndex}
          explanation={question.explanation}
          onNext={() => onDone(chosen === question.answerIndex)}
        />
      )}
    </Card>
  );
}

/**
 * Put items in order by tapping them one by one. Tapping is the accessible
 * default (works with TalkBack and switch access); drag can come later.
 */
function OrderView({ question, onDone, seed }: Props<OrderQuestion> & { seed: number }) {
  const shown = useMemo(() => shuffleForDisplay(question.items, seed), [question.items, seed]);
  const [placed, setPlaced] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
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
              onPress={() => setPlaced(placed.filter((p) => p !== item))}
            />
          ),
        )}
      </View>

      {remaining.length > 0 && (
        <View style={styles.row}>
          {remaining.map((item) => (
            <Button key={item} kind="secondary" label={item} onPress={() => setPlaced([...placed, item])} />
          ))}
        </View>
      )}

      {!checked && remaining.length === 0 && <Button label="Controleer" onPress={() => setChecked(true)} />}

      {checked && (
        <Feedback
          correct={correct}
          explanation={
            correct
              ? question.explanation
              : `De juiste volgorde: ${question.items.join(" → ")}. ${question.explanation}`
          }
          onNext={() => onDone(correct)}
        />
      )}
    </Card>
  );
}
