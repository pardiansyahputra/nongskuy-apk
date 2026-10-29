package app.nongskuy.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColors = lightColorScheme(
    primary = Blue500,
    onPrimary = Gray50,
    primaryContainer = Blue50,
    onPrimaryContainer = Blue900,
    secondary = Orange500,
    onSecondary = Gray50,
    secondaryContainer = Orange200,
    onSecondaryContainer = Orange700,
    background = Gray100,
    onBackground = Gray900,
    surface = Gray50,
    onSurface = Gray900
)

private val DarkColors = darkColorScheme(
    primary = Blue500,
    onPrimary = Gray900,
    primaryContainer = Blue900,
    onPrimaryContainer = Blue50,
    secondary = Orange500,
    onSecondary = Gray900,
    background = Gray900,
    onBackground = Gray200,
    surface = Gray800,
    onSurface = Gray200
)

@Composable
fun NONGSKUYTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColors else LightColors

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}