"""Train three small classifiers on historical candles and compare their results."""
import json
import sys
from collections import Counter

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

FEATURES = ["ret_1", "ret_5", "ret_20", "sma20_gap", "sma50_gap", "rsi14", "macd_gap", "vol20", "volume_ratio"]


def read_candles(rows):
    if rows and isinstance(rows[0], dict):
        frame = pd.DataFrame(rows)
    else:
        frame = pd.DataFrame({"close": rows})
    frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
    frame["volume"] = pd.to_numeric(frame.get("volume", 0), errors="coerce")
    if "date" in frame:
        frame = frame.sort_values("date")
    return frame.dropna(subset=["close"]).reset_index(drop=True)


def make_features(frame):
    close = frame["close"]
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = -delta.clip(upper=0).rolling(14).mean()
    rsi = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    macd_signal = macd.ewm(span=9, adjust=False).mean()
    sma20 = close.rolling(20).mean()
    sma50 = close.rolling(50).mean()
    volume_avg = frame["volume"].rolling(20).mean()
    features = pd.DataFrame({
        "ret_1": close.pct_change(),
        "ret_5": close.pct_change(5),
        "ret_20": close.pct_change(20),
        "sma20_gap": close / sma20 - 1,
        "sma50_gap": close / sma50 - 1,
        "rsi14": rsi.fillna(50) / 100,
        "macd_gap": (macd - macd_signal) / close,
        "vol20": close.pct_change().rolling(20).std(),
        "volume_ratio": (frame["volume"] / volume_avg.replace(0, np.nan)).replace([np.inf, -np.inf], np.nan).fillna(1),
    })
    return features, sma20, sma50, rsi, macd, macd_signal


def label(change):
    if change > 0.015:
        return "UP"
    if change < -0.015:
        return "DOWN"
    return "FLAT"


def analyze(rows):
    frame = read_candles(rows)
    if len(frame) < 90:
        raise ValueError("Need at least 90 daily candles to compare the models.")
    features, sma20, sma50, rsi, macd, macd_signal = make_features(frame)
    future = frame["close"].shift(-5) / frame["close"] - 1
    known = features.copy()
    known["target"] = future.map(lambda value: label(value) if pd.notna(value) else np.nan)
    known = known.dropna()
    split = int(len(known) * 0.8)
    train_end = split - 5  # leave the five-day label horizon between train and test
    train, test = known.iloc[:train_end], known.iloc[split:]
    if len(train) < 40 or len(test) < 10 or train["target"].nunique() < 2:
        raise ValueError("Not enough varied price history to compare the models yet.")

    models = [
        ("Logistic regression", make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000, class_weight="balanced"))),
        ("Random forest", RandomForestClassifier(n_estimators=120, max_depth=5, min_samples_leaf=4, class_weight="balanced_subsample", random_state=7)),
        ("Gradient boosting", GradientBoostingClassifier(n_estimators=100, max_depth=2, learning_rate=0.04, random_state=7)),
    ]
    today = features.iloc[[-1]][FEATURES].replace([np.inf, -np.inf], np.nan).fillna(0)
    comparison = []
    test_votes = []
    for name, model in models:
        model.fit(train[FEATURES], train["target"])
        prediction = model.predict(today)[0]
        probabilities = model.predict_proba(today)[0]
        confidence = float(max(probabilities))
        test_prediction = model.predict(test[FEATURES])
        test_votes.append(test_prediction)
        comparison.append({
            "name": name,
            "signal": prediction,
            "confidence": round(confidence, 3),
            "accuracy": round(float((test_prediction == test["target"]).mean()), 3),
        })

    votes = Counter(item["signal"] for item in comparison)
    overall = votes.most_common(1)[0][0]
    recent = frame.iloc[-1]
    previous = frame.iloc[-2]
    current_rsi = float(rsi.iloc[-1]) if pd.notna(rsi.iloc[-1]) else 50.0
    current_macd = float(macd.iloc[-1]) if pd.notna(macd.iloc[-1]) else 0.0
    current_macd_signal = float(macd_signal.iloc[-1]) if pd.notna(macd_signal.iloc[-1]) else 0.0
    indicators = {
        "rsi14": round(current_rsi, 2),
        "sma20": round(float(sma20.iloc[-1]), 2),
        "sma50": round(float(sma50.iloc[-1]), 2),
        "macd": round(current_macd, 3),
        "macdSignal": round(current_macd_signal, 3),
        "bollingerLow": round(float(sma20.iloc[-1] - 2 * frame["close"].rolling(20).std().iloc[-1]), 2),
        "bollingerHigh": round(float(sma20.iloc[-1] + 2 * frame["close"].rolling(20).std().iloc[-1]), 2),
        "volumeRatio": round(float(frame["volume"].iloc[-1] / frame["volume"].rolling(20).mean().iloc[-1]), 2) if frame["volume"].rolling(20).mean().iloc[-1] else None,
        "priceAboveSma20": bool(recent["close"] > sma20.iloc[-1]),
        "priceAboveSma50": bool(recent["close"] > sma50.iloc[-1]),
        "rsiSignal": "Oversold zone" if current_rsi < 30 else "Overbought zone" if current_rsi > 70 else "Middle range",
        "macdSignalText": "MACD above signal" if current_macd > current_macd_signal else "MACD below signal",
    }
    ensemble_test = np.array([Counter(row).most_common(1)[0][0] for row in zip(*test_votes)])
    accuracy = float((ensemble_test == test["target"].to_numpy()).mean())
    return {
        "signal": overall,
        "confidence": round(votes[overall] / len(comparison), 3),
        "accuracy": round(accuracy, 3),
        "models": comparison,
        "indicators": indicators,
        "candlesUsed": len(frame),
        "price": round(float(recent["close"]), 2),
        "previousClose": round(float(previous["close"]), 2),
    }


if __name__ == "__main__":
    try:
        print(json.dumps(analyze(json.loads(sys.argv[2]))))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
